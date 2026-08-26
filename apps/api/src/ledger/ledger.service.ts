import { HttpStatus, Injectable } from '@nestjs/common';
import type postgres from 'postgres';
import { Money, buildReversal, type DraftLine } from '@acct/domain';
import type {
  AccountDto,
  CreateAccountInput,
  CreateJournalEntryInput,
  JournalEntryDto,
  MoneyDto,
  ReverseEntryInput,
  TrialBalanceDto,
  TrialBalanceQuery,
} from '@acct/shared';
import { Database } from '../db/db.module';
import { LedgerError } from '../common/problem.filter';

interface EntryRow {
  id: string;
  entry_no: string | null;
  entry_ref: string | null;
  entry_date: string;
  period_id: string;
  status: 'draft' | 'posted' | 'reversed' | 'void';
  source_module: JournalEntryDto['sourceModule'];
  memo: string | null;
  base_currency: string;
  posted_at: string | null;
  reverses_entry_id: string | null;
  reversed_by_entry_id: string | null;
}

interface LineRow {
  id: string;
  line_no: number;
  account_id: string;
  account_code: string;
  account_name: string;
  side: 'debit' | 'credit';
  amount_minor: string;
  currency_code: string;
  fx_rate: string;
  base_amount_minor: string;
  description: string | null;
}

function money(minor: string | bigint, currency: string): MoneyDto {
  return Money.fromMinor(minor, currency).toJSON();
}

@Injectable()
export class LedgerService {
  constructor(private readonly db: Database) {}

  // --- chart of accounts ----------------------------------------------

  async listAccounts(tenantId: string): Promise<AccountDto[]> {
    const rows = await this.db.sql<Record<string, never>[]>`
      SELECT id, code, name, name_ar, type, subtype, normal_balance, parent_account_id,
             currency_code, is_bank, is_control_account, is_postable, is_active
        FROM accounts WHERE tenant_id = ${tenantId} ORDER BY code`;
    return rows.map(toAccountDto);
  }

  async createAccount(tenantId: string, input: CreateAccountInput): Promise<AccountDto> {
    const normalBalance = input.type === 'asset' || input.type === 'expense' ? 'debit' : 'credit';
    const rows = await this.db.transaction(tenantId, async (tx) => {
      return tx<Record<string, never>[]>`
        INSERT INTO accounts (
          tenant_id, code, name, name_ar, type, subtype, normal_balance,
          parent_account_id, currency_code, is_bank, is_control_account
        ) VALUES (
          ${tenantId}, ${input.code}, ${input.name}, ${input.nameAr ?? null},
          ${input.type}::account_type, ${input.subtype ?? null}, ${normalBalance}::normal_balance,
          ${input.parentAccountId ?? null}, ${input.currencyCode ?? null},
          ${input.isBank}, ${input.isControlAccount}
        )
        RETURNING id, code, name, name_ar, type, subtype, normal_balance, parent_account_id,
                  currency_code, is_bank, is_control_account, is_postable, is_active`;
    });
    return toAccountDto(rows[0]!);
  }

  // --- journal ---------------------------------------------------------

  async createEntry(
    tenantId: string,
    input: CreateJournalEntryInput,
    idempotencyKey?: string,
  ): Promise<{ entry: JournalEntryDto; replayed: boolean }> {
    if (idempotencyKey) {
      const existing = await this.findByExternalId(tenantId, idempotencyKey);
      if (existing) return { entry: existing, replayed: true };
    }

    const tenant = await this.requireTenant(tenantId);
    const period = await this.requirePeriodFor(tenantId, input.entryDate);

    try {
      const id = await this.db.transaction(tenantId, async (tx) => {
        const [entry] = await tx<{ id: string }[]>`
          INSERT INTO journal_entries (
            tenant_id, entry_date, period_id, fiscal_year_id, status, source_module,
            memo, base_currency, source_system, external_id
          ) VALUES (
            ${tenantId}, ${input.entryDate}, ${period.id}, ${period.fiscal_year_id},
            ${input.status}::entry_status, ${input.sourceModule}::source_module,
            ${input.memo ?? null}, ${tenant.base_currency},
            ${idempotencyKey ? 'api' : null}, ${idempotencyKey ?? null}
          ) RETURNING id`;

        await this.insertLines(tx, tenantId, entry!.id, input.lines, tenant.base_currency);
        return entry!.id;
      });

      return { entry: await this.getEntry(tenantId, id), replayed: false };
    } catch (err) {
      // A concurrent request with the same key won the race: return its result.
      if (idempotencyKey && /journal_entries_idempotency_unique/.test(String(err))) {
        const existing = await this.findByExternalId(tenantId, idempotencyKey);
        if (existing) return { entry: existing, replayed: true };
      }
      throw err;
    }
  }

  /** Move a draft to posted. The database re-checks every invariant at COMMIT. */
  async postEntry(tenantId: string, entryId: string): Promise<JournalEntryDto> {
    const current = await this.getEntry(tenantId, entryId);
    if (current.status !== 'draft') {
      throw new LedgerError(
        'ENTRY_NOT_DRAFT',
        `Entry ${current.entryRef ?? entryId} is ${current.status} and cannot be posted again`,
        HttpStatus.CONFLICT,
      );
    }

    await this.db.transaction(tenantId, async (tx) => {
      await tx`
        UPDATE journal_entries SET status = 'posted', updated_at = now()
         WHERE id = ${entryId} AND tenant_id = ${tenantId}`;
    });
    return this.getEntry(tenantId, entryId);
  }

  /**
   * Post the mirror image of an entry and link the two.
   * The original is never edited — invariant 2 — only marked as reversed.
   */
  async reverseEntry(
    tenantId: string,
    entryId: string,
    input: ReverseEntryInput,
  ): Promise<{ original: JournalEntryDto; reversal: JournalEntryDto }> {
    const original = await this.getEntry(tenantId, entryId);
    if (original.status !== 'posted') {
      throw new LedgerError(
        'ENTRY_NOT_REVERSIBLE',
        `Only a posted entry can be reversed; entry ${original.entryRef ?? entryId} is ${original.status}`,
        HttpStatus.CONFLICT,
      );
    }

    const entryDate = input.entryDate ?? original.entryDate;
    const period = await this.requirePeriodFor(tenantId, entryDate);

    // Compute the mirrored lines with the domain rules, not by hand.
    const draftLines: DraftLine[] = original.lines.map((line, index) => ({
      lineNo: index + 1,
      accountId: line.accountId,
      side: line.side,
      amountMinor: BigInt(line.amount.minor),
      currencyCode: line.amount.currency,
      fxRate: line.fxRate,
      baseAmountMinor: BigInt(line.baseAmount.minor),
      description: line.description ?? undefined,
    }));
    const mirrored = buildReversal(
      {
        entryDate,
        baseCurrencyCode: original.baseCurrency,
        sourceModule: original.sourceModule,
        memo: original.memo ?? undefined,
        lines: draftLines,
      },
      { entryDate, memo: `Reversal of ${original.entryRef ?? entryId}: ${input.reason}` },
    );

    const reversalId = await this.db.transaction(tenantId, async (tx) => {
      const [reversal] = await tx<{ id: string }[]>`
        INSERT INTO journal_entries (
          tenant_id, entry_date, period_id, fiscal_year_id, status, source_module,
          memo, base_currency, reverses_entry_id, reversal_reason
        ) VALUES (
          ${tenantId}, ${entryDate}, ${period.id}, ${period.fiscal_year_id},
          'posted', ${original.sourceModule}::source_module, ${mirrored.memo ?? null},
          ${original.baseCurrency}, ${entryId}, ${input.reason}
        ) RETURNING id`;

      await tx`
        INSERT INTO journal_lines (
          tenant_id, entry_id, line_no, account_id, side, amount_minor,
          currency_code, fx_rate, base_amount_minor, description
        )
        SELECT ${tenantId}, ${reversal!.id}, l.line_no, l.account_id,
               CASE l.side WHEN 'debit' THEN 'credit' ELSE 'debit' END::entry_side,
               l.amount_minor, l.currency_code, l.fx_rate, l.base_amount_minor,
               ${`Reversal: ${input.reason}`}
          FROM journal_lines l WHERE l.entry_id = ${entryId} ORDER BY l.line_no`;

      await tx`
        UPDATE journal_entries
           SET status = 'reversed', reversed_by_entry_id = ${reversal!.id},
               reversal_reason = ${input.reason}, updated_at = now()
         WHERE id = ${entryId} AND tenant_id = ${tenantId}`;

      return reversal!.id;
    });

    return {
      original: await this.getEntry(tenantId, entryId),
      reversal: await this.getEntry(tenantId, reversalId),
    };
  }

  async getEntry(tenantId: string, entryId: string): Promise<JournalEntryDto> {
    const [entry] = await this.db.sql<EntryRow[]>`
      SELECT id, entry_no::text, entry_ref, entry_date::text, period_id, status, source_module,
             memo, base_currency, posted_at::text, reverses_entry_id, reversed_by_entry_id
        FROM journal_entries WHERE id = ${entryId} AND tenant_id = ${tenantId}`;

    if (!entry) {
      throw new LedgerError('ENTRY_NOT_FOUND', `No journal entry ${entryId}`, HttpStatus.NOT_FOUND);
    }

    const lines = await this.db.sql<LineRow[]>`
      SELECT l.id, l.line_no, l.account_id, a.code AS account_code, a.name AS account_name,
             l.side, l.amount_minor::text, l.currency_code, l.fx_rate::text,
             l.base_amount_minor::text, l.description
        FROM journal_lines l JOIN accounts a ON a.id = l.account_id
       WHERE l.entry_id = ${entryId} ORDER BY l.line_no`;

    return toEntryDto(entry, lines);
  }

  async listEntries(
    tenantId: string,
    options: { limit: number; cursor?: string },
  ): Promise<{ items: JournalEntryDto[]; nextCursor: string | null }> {
    const rows = await this.db.sql<{ id: string }[]>`
      SELECT id FROM journal_entries
       WHERE tenant_id = ${tenantId}
         ${options.cursor ? this.db.sql`AND id < ${options.cursor}` : this.db.sql``}
       ORDER BY id DESC LIMIT ${options.limit + 1}`;

    const page = rows.slice(0, options.limit);
    const items = await Promise.all(page.map((r) => this.getEntry(tenantId, r.id)));
    return {
      items,
      nextCursor: rows.length > options.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  // --- reports ---------------------------------------------------------

  /**
   * The trial balance is computed from journal lines, never from the balance
   * cache, so a stale cache can never make a report look right.
   */
  async trialBalance(tenantId: string, query: TrialBalanceQuery): Promise<TrialBalanceDto> {
    const tenant = await this.requireTenant(tenantId);
    const currency = tenant.base_currency;

    const rows = await this.db.sql<
      {
        account_id: string;
        code: string;
        name: string;
        type: TrialBalanceDto['rows'][number]['accountType'];
        normal_balance: 'debit' | 'credit';
        debit_total: string;
        credit_total: string;
      }[]
    >`
      SELECT l.account_id, a.code, a.name, a.type, a.normal_balance,
             COALESCE(SUM(l.base_amount_minor) FILTER (WHERE l.side = 'debit'), 0)::text  AS debit_total,
             COALESCE(SUM(l.base_amount_minor) FILTER (WHERE l.side = 'credit'), 0)::text AS credit_total
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id
        JOIN accounts a ON a.id = l.account_id
       WHERE l.tenant_id = ${tenantId}
         AND e.status IN ('posted', 'reversed')
         ${query.fromDate ? this.db.sql`AND e.entry_date >= ${query.fromDate}` : this.db.sql``}
         ${query.toDate ? this.db.sql`AND e.entry_date <= ${query.toDate}` : this.db.sql``}
         ${query.periodId ? this.db.sql`AND e.period_id = ${query.periodId}` : this.db.sql``}
       GROUP BY l.account_id, a.code, a.name, a.type, a.normal_balance
       ORDER BY a.code`;

    let totalDebit = Money.zero(currency);
    let totalCredit = Money.zero(currency);

    const items = rows
      .map((row) => {
        const debit = Money.fromMinor(row.debit_total, currency);
        const credit = Money.fromMinor(row.credit_total, currency);
        totalDebit = totalDebit.add(debit);
        totalCredit = totalCredit.add(credit);
        const closing =
          row.normal_balance === 'debit' ? debit.subtract(credit) : credit.subtract(debit);
        return {
          accountId: row.account_id,
          accountCode: row.code,
          accountName: row.name,
          accountType: row.type,
          debitTotal: debit.toJSON(),
          creditTotal: credit.toJSON(),
          closingBalance: closing.toJSON(),
        };
      })
      .filter((row) => query.includeZeroBalances || row.closingBalance.minor !== '0');

    const difference = totalDebit.subtract(totalCredit);

    return {
      currency,
      fromDate: query.fromDate ?? null,
      toDate: query.toDate ?? null,
      rows: items,
      totalDebit: totalDebit.toJSON(),
      totalCredit: totalCredit.toJSON(),
      difference: difference.toJSON(),
      balanced: difference.isZero(),
    };
  }

  async listPeriods(tenantId: string): Promise<
    { id: string; periodNo: number; startDate: string; endDate: string; status: string }[]
  > {
    const rows = await this.db.sql<
      { id: string; period_no: number; start_date: string; end_date: string; status: string }[]
    >`
      SELECT p.id, p.period_no, p.start_date::text, p.end_date::text, p.status
        FROM fiscal_periods p WHERE p.tenant_id = ${tenantId}
       ORDER BY p.start_date`;
    return rows.map((r) => ({
      id: r.id,
      periodNo: r.period_no,
      startDate: r.start_date,
      endDate: r.end_date,
      status: r.status,
    }));
  }

  // --- internals -------------------------------------------------------

  private async insertLines(
    tx: postgres.TransactionSql,
    tenantId: string,
    entryId: string,
    lines: CreateJournalEntryInput['lines'],
    baseCurrency: string,
  ): Promise<void> {
    let lineNo = 1;
    for (const line of lines) {
      const currency = line.currencyCode ?? baseCurrency;
      const isBase = currency === baseCurrency;
      const fxRate = isBase ? '1' : (line.fxRate ?? '1');
      const baseAmount = isBase
        ? line.amountMinor
        : (line.baseAmountMinor ??
          Money.fromMinor(line.amountMinor, currency).multiply(fxRate).minor.toString());

      await tx`
        INSERT INTO journal_lines (
          tenant_id, entry_id, line_no, account_id, side, amount_minor,
          currency_code, fx_rate, base_amount_minor, description,
          contact_id, cost_center_id, project_id
        ) VALUES (
          ${tenantId}, ${entryId}, ${lineNo}, ${line.accountId}, ${line.side}::entry_side,
          ${line.amountMinor}, ${currency}, ${fxRate}, ${baseAmount},
          ${line.description ?? null}, ${line.contactId ?? null},
          ${line.costCenterId ?? null}, ${line.projectId ?? null}
        )`;
      lineNo += 1;
    }
  }

  private async findByExternalId(tenantId: string, key: string): Promise<JournalEntryDto | null> {
    const [row] = await this.db.sql<{ id: string }[]>`
      SELECT id FROM journal_entries
       WHERE tenant_id = ${tenantId} AND source_system = 'api' AND external_id = ${key}`;
    return row ? this.getEntry(tenantId, row.id) : null;
  }

  private async requireTenant(tenantId: string): Promise<{ base_currency: string }> {
    const [tenant] = await this.db.sql<{ base_currency: string }[]>`
      SELECT base_currency FROM tenants WHERE id = ${tenantId}`;
    if (!tenant) {
      throw new LedgerError('TENANT_NOT_FOUND', `No tenant ${tenantId}`, HttpStatus.NOT_FOUND);
    }
    return tenant;
  }

  private async requirePeriodFor(
    tenantId: string,
    entryDate: string,
  ): Promise<{ id: string; fiscal_year_id: string; status: string }> {
    const [period] = await this.db.sql<
      { id: string; fiscal_year_id: string; status: string }[]
    >`
      SELECT id, fiscal_year_id, status FROM fiscal_periods
       WHERE tenant_id = ${tenantId} AND ${entryDate}::date BETWEEN start_date AND end_date`;

    if (!period) {
      throw new LedgerError(
        'NO_FISCAL_PERIOD',
        `No fiscal period covers ${entryDate}; create the fiscal year first`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return period;
  }
}

function toAccountDto(row: Record<string, never>): AccountDto {
  const r = row as unknown as {
    id: string;
    code: string;
    name: string;
    name_ar: string | null;
    type: AccountDto['type'];
    subtype: string | null;
    normal_balance: AccountDto['normalBalance'];
    parent_account_id: string | null;
    currency_code: string | null;
    is_bank: boolean;
    is_control_account: boolean;
    is_postable: boolean;
    is_active: boolean;
  };
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    nameAr: r.name_ar,
    type: r.type,
    subtype: r.subtype,
    normalBalance: r.normal_balance,
    parentAccountId: r.parent_account_id,
    currencyCode: r.currency_code,
    isBank: r.is_bank,
    isControlAccount: r.is_control_account,
    isPostable: r.is_postable,
    isActive: r.is_active,
  };
}

function toEntryDto(entry: EntryRow, lines: LineRow[]): JournalEntryDto {
  let totalDebit = Money.zero(entry.base_currency);
  let totalCredit = Money.zero(entry.base_currency);
  for (const line of lines) {
    const base = Money.fromMinor(line.base_amount_minor, entry.base_currency);
    if (line.side === 'debit') totalDebit = totalDebit.add(base);
    else totalCredit = totalCredit.add(base);
  }

  return {
    id: entry.id,
    entryNo: entry.entry_no === null ? null : Number(entry.entry_no),
    entryRef: entry.entry_ref,
    entryDate: entry.entry_date,
    periodId: entry.period_id,
    status: entry.status,
    sourceModule: entry.source_module,
    memo: entry.memo,
    baseCurrency: entry.base_currency,
    postedAt: entry.posted_at,
    reversesEntryId: entry.reverses_entry_id,
    reversedByEntryId: entry.reversed_by_entry_id,
    totalDebit: totalDebit.toJSON(),
    totalCredit: totalCredit.toJSON(),
    lines: lines.map((line) => ({
      id: line.id,
      lineNo: line.line_no,
      accountId: line.account_id,
      accountCode: line.account_code,
      accountName: line.account_name,
      side: line.side,
      amount: money(line.amount_minor, line.currency_code),
      baseAmount: money(line.base_amount_minor, entry.base_currency),
      fxRate: line.fx_rate,
      description: line.description,
    })),
  };
}
