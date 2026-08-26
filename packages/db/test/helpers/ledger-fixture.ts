import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * A real Postgres, migrated, with one tenant and a small chart of accounts.
 *
 * The invariants under test live in triggers and deferred constraints, so they
 * cannot be exercised against a mock or an in-memory stand-in — the point of
 * these tests is precisely that the database refuses what the API might not.
 */
export interface LedgerFixture {
  sql: postgres.Sql;
  tenantId: string;
  userId: string;
  fiscalYearId: string;
  /** Period 1 (January), open. */
  periodId: string;
  /** Period 2 (February), open. */
  period2Id: string;
  accounts: Record<'cash' | 'revenue' | 'taxPayable' | 'rent' | 'parent' | 'usdBank', string>;
  stop: () => Promise<void>;
}

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

export async function startLedgerFixture(): Promise<LedgerFixture> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('ledger_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  const sql = postgres(container.getConnectionUri(), { max: 5, onnotice: () => {} });

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  for (const file of files) {
    await sql.unsafe(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));
  }

  await sql`
    INSERT INTO currencies (code, name, symbol, minor_unit_exponent) VALUES
      ('JOD', 'Jordanian Dinar', 'JD', 3),
      ('USD', 'US Dollar', '$', 2),
      ('JPY', 'Japanese Yen', '¥', 0)`;

  const [tenant] = await sql<{ id: string }[]>`
    INSERT INTO tenants (name, slug, base_currency) VALUES ('Test Co', 'test', 'JOD') RETURNING id`;
  const tenantId = tenant!.id;

  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (tenant_id, email, display_name)
    VALUES (${tenantId}, 'tester@test.local', 'Tester') RETURNING id`;
  const userId = user!.id;

  const [year] = await sql<{ id: string }[]>`
    INSERT INTO fiscal_years (tenant_id, name, start_date, end_date)
    VALUES (${tenantId}, '2026', '2026-01-01', '2026-12-31') RETURNING id`;
  const fiscalYearId = year!.id;

  const periods = await sql<{ id: string; period_no: number }[]>`
    INSERT INTO fiscal_periods (tenant_id, fiscal_year_id, period_no, start_date, end_date) VALUES
      (${tenantId}, ${fiscalYearId}, 1, '2026-01-01', '2026-01-31'),
      (${tenantId}, ${fiscalYearId}, 2, '2026-02-01', '2026-02-28'),
      (${tenantId}, ${fiscalYearId}, 3, '2026-03-01', '2026-03-31')
    RETURNING id, period_no`;

  const accountRows = await sql<{ id: string; code: string }[]>`
    INSERT INTO accounts (tenant_id, code, name, type, normal_balance, currency_code, is_bank, is_postable) VALUES
      (${tenantId}, '1000', 'Assets',          'asset',     'debit',  NULL,  false, false),
      (${tenantId}, '1110', 'Cash',            'asset',     'debit',  NULL,  false, true),
      (${tenantId}, '1125', 'USD Bank',        'asset',     'debit',  'USD', true,  true),
      (${tenantId}, '2130', 'Output Tax',      'liability', 'credit', NULL,  false, true),
      (${tenantId}, '4010', 'Sales Revenue',   'revenue',   'credit', NULL,  false, true),
      (${tenantId}, '5220', 'Rent Expense',    'expense',   'debit',  NULL,  false, true)
    RETURNING id, code`;

  const byCode = (code: string): string => accountRows.find((a) => a.code === code)!.id;

  return {
    sql,
    tenantId,
    userId,
    fiscalYearId,
    periodId: periods.find((p) => p.period_no === 1)!.id,
    period2Id: periods.find((p) => p.period_no === 2)!.id,
    accounts: {
      parent: byCode('1000'),
      cash: byCode('1110'),
      usdBank: byCode('1125'),
      taxPayable: byCode('2130'),
      revenue: byCode('4010'),
      rent: byCode('5220'),
    },
    stop: async () => {
      await sql.end();
      await container.stop();
    },
  };
}

export interface PostLine {
  accountId: string;
  side: 'debit' | 'credit';
  amountMinor: bigint;
  currencyCode?: string;
  fxRate?: string;
  baseAmountMinor?: bigint;
}

/**
 * Insert a header and its lines in one transaction, the way the API does.
 * The balance check is deferred, so failures surface at COMMIT.
 */
export async function postEntry(
  fx: LedgerFixture,
  options: {
    lines: PostLine[];
    entryDate?: string;
    periodId?: string;
    status?: 'draft' | 'posted';
    memo?: string;
    externalId?: string;
    sourceSystem?: string;
    isAdjustment?: boolean;
    sql?: postgres.Sql | postgres.TransactionSql;
  },
): Promise<{ id: string; entryNo: bigint | null; entryRef: string | null }> {
  const runner = options.sql ?? fx.sql;
  return runner.begin(async (tx) => {
    const [entry] = await tx<{ id: string; entry_no: string | null; entry_ref: string | null }[]>`
      INSERT INTO journal_entries (
        tenant_id, entry_date, period_id, fiscal_year_id, status, base_currency,
        memo, external_id, source_system, is_adjustment, created_by, posted_by
      ) VALUES (
        ${fx.tenantId}, ${options.entryDate ?? '2026-01-15'},
        ${options.periodId ?? fx.periodId}, ${fx.fiscalYearId},
        ${options.status ?? 'posted'}::entry_status, 'JOD',
        ${options.memo ?? 'test entry'}, ${options.externalId ?? null},
        ${options.sourceSystem ?? null}, ${options.isAdjustment ?? false},
        ${fx.userId}, ${fx.userId}
      ) RETURNING id, entry_no::text, entry_ref`;

    let lineNo = 1;
    for (const line of options.lines) {
      await tx`
        INSERT INTO journal_lines (
          tenant_id, entry_id, line_no, account_id, side, amount_minor,
          currency_code, fx_rate, base_amount_minor, created_by
        ) VALUES (
          ${fx.tenantId}, ${entry!.id}, ${lineNo}, ${line.accountId},
          ${line.side}::entry_side, ${line.amountMinor.toString()},
          ${line.currencyCode ?? 'JOD'}, ${line.fxRate ?? '1'},
          ${(line.baseAmountMinor ?? line.amountMinor).toString()}, ${fx.userId}
        )`;
      lineNo += 1;
    }

    return {
      id: entry!.id,
      entryNo: entry!.entry_no === null ? null : BigInt(entry!.entry_no),
      entryRef: entry!.entry_ref,
    };
  }) as Promise<{ id: string; entryNo: bigint | null; entryRef: string | null }>;
}
