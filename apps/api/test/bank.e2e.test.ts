import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import postgres from 'postgres';
import cookieParser from 'cookie-parser';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';

/** Banking end to end: import → auto-match → categorise → reconcile → lock. */

let container: StartedPostgreSqlContainer;
let app: INestApplication;
let owner: postgres.Sql;
let client: request.Agent;
let csrf = '';

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');
const PASSWORD = 'Correct-Horse-Battery-9';
const EMAIL = 'bank@test.local';

let tenantId: string;
let accounts: Record<'bank' | 'usdBank' | 'ar' | 'revenue' | 'utilities' | 'fxGain' | 'fxLoss', string>;
let bankAccountId: string;
let usdBankAccountId: string;
let customerId: string;

function post(path: string): request.Test {
  return client.post(path).set('X-CSRF-Token', csrf);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('bank_test')
    .withUsername('owner')
    .withPassword('owner')
    .start();

  owner = postgres(container.getConnectionUri(), { max: 5, onnotice: () => {} });
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  for (const file of files) await owner.unsafe(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));

  await owner`
    INSERT INTO currencies (code, name, symbol, minor_unit_exponent)
    VALUES ('JOD','Jordanian Dinar','JD',3), ('USD','US Dollar','$',2)`;
  const [tenant] = await owner<{ id: string }[]>`
    INSERT INTO tenants (name, slug, base_currency) VALUES ('Bank Test','bank-test','JOD') RETURNING id`;
  tenantId = tenant!.id;
  await owner`
    INSERT INTO company_settings (tenant_id, legal_name, base_currency)
    VALUES (${tenantId}, 'Bank Test LLC', 'JOD')`;

  const { AuthService } = await import('../src/auth/auth.service');
  const [user] = await owner<{ id: string }[]>`
    INSERT INTO users (tenant_id, email, display_name, password_hash)
    VALUES (${tenantId}, ${EMAIL}, 'Bank Tester', ${await AuthService.hashPassword(PASSWORD)})
    RETURNING id`;
  const [role] = await owner<{ id: string }[]>`
    INSERT INTO roles (tenant_id, code, name, is_system) VALUES (${tenantId},'all','All',true) RETURNING id`;
  await owner`INSERT INTO role_permissions (role_id, permission_code) SELECT ${role!.id}, code FROM permissions`;
  await owner`INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES (${user!.id}, ${role!.id}, ${tenantId})`;

  await owner.unsafe(`CREATE ROLE acct_app_user LOGIN PASSWORD 'app-secret' IN ROLE acct_app`);
  await owner`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO acct_app`;
  await owner`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO acct_app`;
  await owner`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO acct_app`;

  const [year] = await owner<{ id: string }[]>`
    INSERT INTO fiscal_years (tenant_id, name, start_date, end_date)
    VALUES (${tenantId},'2026','2026-01-01','2026-12-31') RETURNING id`;
  for (let month = 1; month <= 12; month += 1) {
    await owner`
      INSERT INTO fiscal_periods (tenant_id, fiscal_year_id, period_no, start_date, end_date)
      VALUES (${tenantId}, ${year!.id}, ${month},
              ${new Date(Date.UTC(2026, month - 1, 1)).toISOString().slice(0, 10)},
              ${new Date(Date.UTC(2026, month, 0)).toISOString().slice(0, 10)})`;
  }

  const rows = await owner<{ id: string; code: string }[]>`
    INSERT INTO accounts (tenant_id, code, name, type, subtype, normal_balance, currency_code, is_bank) VALUES
      (${tenantId},'1120','Bank JOD','asset','bank','debit',NULL,true),
      (${tenantId},'1125','Bank USD','asset','bank','debit','USD',true),
      (${tenantId},'1130','Accounts Receivable','asset','receivable','debit',NULL,false),
      (${tenantId},'4010','Sales Revenue','revenue','operating_revenue','credit',NULL,false),
      (${tenantId},'4900','Realised FX Gain','revenue','other_income','credit',NULL,false),
      (${tenantId},'5230','Utilities','expense','operating_expense','debit',NULL,false),
      (${tenantId},'5900','Realised FX Loss','expense','other_expense','debit',NULL,false),
      (${tenantId},'1190','Currency Exchange Clearing','asset','fx_clearing','debit',NULL,false)
    RETURNING id, code`;
  const byCode = (code: string): string => rows.find((r) => r.code === code)!.id;
  accounts = {
    bank: byCode('1120'),
    usdBank: byCode('1125'),
    ar: byCode('1130'),
    revenue: byCode('4010'),
    fxGain: byCode('4900'),
    utilities: byCode('5230'),
    fxLoss: byCode('5900'),
  };

  const [customer] = await owner<{ id: string }[]>`
    INSERT INTO contacts (tenant_id, code, name, is_customer)
    VALUES (${tenantId}, 'CUST-1', 'Petra Trading LLC', true) RETURNING id`;
  customerId = customer!.id;

  for (const [docType, prefix] of [
    ['journal_entry', 'JE-'],
    ['customer_receipt', 'RCT-'],
  ] as const) {
    await owner`
      INSERT INTO number_sequences (tenant_id, doc_type, scope_key, prefix, padding)
      VALUES (${tenantId}, ${docType}, ${docType === 'journal_entry' ? year!.id : ''}, ${prefix}, 5)`;
  }

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: `postgresql://acct_app_user:app-secret@${container.getHost()}:${container.getPort()}/bank_test`,
    MIGRATION_DATABASE_URL: container.getConnectionUri(),
    JWT_ACCESS_SECRET: 'test-access-secret-that-is-long-enough-32',
    JWT_REFRESH_SECRET: 'test-refresh-secret-that-is-long-enough-32',
    REDIS_URL: 'redis://localhost:6379',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_BUCKET: 'test',
    S3_ACCESS_KEY: 'test',
    S3_SECRET_KEY: 'test',
    SMTP_HOST: 'localhost',
    SMTP_PORT: '1025',
  });

  const { AppModule } = await import('../src/app.module');
  const { ProblemFilter } = await import('../src/common/problem.filter');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
  app.useGlobalFilters(new ProblemFilter());
  await app.init();

  client = request.agent(app.getHttpServer());
  await client.post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD }).expect(200);
  const me = await client.get('/api/v1/auth/me').expect(200);
  const cookies = (me.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  csrf = cookies.find((c) => c.startsWith('csrf_token='))?.split(';')[0]?.split('=')[1] ?? '';

  const jod = await post('/api/v1/bank-accounts')
    .send({ accountId: accounts.bank, name: 'Main JOD account', currencyCode: 'JOD', iban: 'JO94CBJO001' })
    .expect(201);
  bankAccountId = jod.body.id;

  const usd = await post('/api/v1/bank-accounts')
    .send({ accountId: accounts.usdBank, name: 'USD account', currencyCode: 'USD' })
    .expect(201);
  usdBankAccountId = usd.body.id;

  // A receipt already in the ledger, which the statement should find.
  await post('/api/v1/journal-entries')
    .send({
      entryDate: '2026-01-05',
      status: 'posted',
      memo: 'Customer receipt INV-1001',
      lines: [
        { accountId: accounts.bank, side: 'debit', amountMinor: '1160000', description: 'INV-1001' },
        { accountId: accounts.ar, side: 'credit', amountMinor: '1160000' },
      ],
    })
    .expect(201);
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await container?.stop();
});

const CSV = [
  'Date,Description,Reference,Money In,Money Out',
  '2026-01-05,PETRA TRADING LLC INV-1001,INV-1001,1160.000,',
  '2026-01-07,JORDAN ELECTRIC BILL,,,250.000',
  '2026-01-09,UNIDENTIFIED DEPOSIT,,999.000,',
].join('\n');

const CSV_MAPPING = {
  dateColumn: 'Date',
  descriptionColumn: 'Description',
  referenceColumn: 'Reference',
  creditColumn: 'Money In',
  debitColumn: 'Money Out',
};

describe('statement import', () => {
  it('imports a CSV and auto-matches what it can', async () => {
    const res = await post('/api/v1/bank-statements/import')
      .send({ bankAccountId, format: 'csv', content: CSV, filename: 'jan.csv', csvMapping: CSV_MAPPING })
      .expect(201);

    expect(res.body.imported).toBe(3);
    // The receipt already in the ledger is found by amount, date and reference.
    expect(res.body.suggested).toBe(1);
  });

  it('marks the matched line with its confidence and reason', async () => {
    const res = await client
      .get(`/api/v1/bank-accounts/${bankAccountId}/statement-lines`)
      .expect(200);
    const matched = res.body.find((l: { reference: string }) => l.reference === 'INV-1001');
    expect(matched.status).toBe('suggested');
    expect(matched.match_confidence).toBe('exact');
    expect(matched.match_reason).toContain('reference');
  });

  it('leaves the lines it cannot decide unmatched', async () => {
    const res = await client
      .get(`/api/v1/bank-accounts/${bankAccountId}/statement-lines?status=unmatched`)
      .expect(200);
    expect(res.body).toHaveLength(2);
  });

  it('refuses the same file twice', async () => {
    const res = await post('/api/v1/bank-statements/import')
      .send({ bankAccountId, format: 'csv', content: CSV, csvMapping: CSV_MAPPING })
      .expect(409);
    expect(res.body.code).toBe('STATEMENT_ALREADY_IMPORTED');
  });

  it('reports a parse failure with the offending row', async () => {
    const res = await post('/api/v1/bank-statements/import')
      .send({
        bankAccountId,
        format: 'csv',
        content: 'Date,Description,Amount\n2026-01-05,X,not-a-number',
        csvMapping: { dateColumn: 'Date', descriptionColumn: 'Description', amountColumn: 'Amount' },
      })
      .expect(500);
    expect(res.body.code).toBeTruthy();
  });

  it('imports an MT940 file for the same account', async () => {
    const mt940 = [
      ':20:STMT002',
      ':25:JO94CBJO001',
      ':60F:C260201JOD1910,000',
      ':61:2602100210D125,500NTRFWATER//W-1',
      ':86:WATER AUTHORITY FEBRUARY',
      ':62F:C260228JOD1784,500',
      '-',
    ].join('\n');

    const res = await post('/api/v1/bank-statements/import')
      .send({ bankAccountId, format: 'mt940', content: mt940, filename: 'feb.sta' })
      .expect(201);
    expect(res.body.imported).toBe(1);
  });
});

describe('matching and categorising', () => {
  it('confirms a suggested match', async () => {
    const lines = await client
      .get(`/api/v1/bank-accounts/${bankAccountId}/statement-lines?status=suggested`)
      .expect(200);
    const line = lines.body[0];
    await post(`/api/v1/bank-statement-lines/${line.id}/match`).send({}).expect(204);

    const after = await client
      .get(`/api/v1/bank-accounts/${bankAccountId}/statement-lines`)
      .expect(200);
    expect(after.body.find((l: { id: string }) => l.id === line.id).status).toBe('matched');
  });

  it('categorises an unmatched line by posting the missing entry', async () => {
    const lines = await client
      .get(`/api/v1/bank-accounts/${bankAccountId}/statement-lines?status=unmatched`)
      .expect(200);
    const electricity = lines.body.find((l: { description: string }) =>
      l.description.includes('ELECTRIC'),
    );

    const res = await post(`/api/v1/bank-statement-lines/${electricity.id}/categorise`)
      .send({ accountId: accounts.utilities, description: 'January electricity' })
      .expect(201);
    expect(res.body.entryId).toBeTruthy();

    // Money out of the bank: credit bank, debit the expense.
    const entry = await client.get(`/api/v1/journal-entries/${res.body.entryId}`).expect(200);
    const bankLine = entry.body.lines.find((l: { accountCode: string }) => l.accountCode === '1120');
    const expenseLine = entry.body.lines.find((l: { accountCode: string }) => l.accountCode === '5230');
    expect(bankLine.side).toBe('credit');
    expect(expenseLine.side).toBe('debit');
    expect(expenseLine.amount.amount).toBe('250.000');
  });

  it('will not categorise a line that is already matched', async () => {
    const lines = await client
      .get(`/api/v1/bank-accounts/${bankAccountId}/statement-lines?status=matched`)
      .expect(200);
    const res = await post(`/api/v1/bank-statement-lines/${lines.body[0].id}/categorise`)
      .send({ accountId: accounts.utilities })
      .expect(409);
    expect(res.body.code).toBe('LINE_ALREADY_MATCHED');
  });

  it('unmatches a line that is not locked', async () => {
    const lines = await client
      .get(`/api/v1/bank-accounts/${bankAccountId}/statement-lines?status=matched`)
      .expect(200);
    const line = lines.body[0];
    await post(`/api/v1/bank-statement-lines/${line.id}/unmatch`).expect(204);
    const after = await client
      .get(`/api/v1/bank-accounts/${bankAccountId}/statement-lines`)
      .expect(200);
    expect(after.body.find((l: { id: string }) => l.id === line.id).status).toBe('unmatched');
    // Put it back for the reconciliation tests.
    await post(`/api/v1/bank-statement-lines/${line.id}/match`)
      .send({ entryId: line.matched_entry_id })
      .expect(204);
  });
});

describe('bank rules', () => {
  it('applies a rule to a line the matcher could not place', async () => {
    await post('/api/v1/bank-rules')
      .send({
        name: 'Water authority to utilities',
        descriptionContains: 'WATER AUTHORITY',
        direction: 'out',
        accountId: accounts.utilities,
        priority: 10,
      })
      .expect(201);

    // Re-running the matcher happens on import; import a fresh statement.
    await post('/api/v1/bank-statements/import')
      .send({
        bankAccountId,
        format: 'csv',
        content: 'Date,Description,Amount\n2026-03-01,WATER AUTHORITY MARCH,-75.000',
        csvMapping: { dateColumn: 'Date', descriptionColumn: 'Description', amountColumn: 'Amount' },
      })
      .expect(201);

    const lines = await client
      .get(`/api/v1/bank-accounts/${bankAccountId}/statement-lines`)
      .expect(200);
    const water = lines.body.find((l: { description: string }) =>
      l.description.includes('WATER AUTHORITY MARCH'),
    );
    expect(water.match_confidence).toBe('rule');
    expect(water.match_reason).toContain('Water authority to utilities');
  });

  it('lists rules in priority order', async () => {
    const res = await client.get('/api/v1/bank-rules').expect(200);
    expect(res.body[0].priority).toBeLessThanOrEqual(res.body.at(-1).priority);
  });
});

describe('bank transfers', () => {
  it('moves money between own accounts with no gain or loss', async () => {
    const res = await post('/api/v1/bank-transfers')
      .send({
        fromBankAccountId: bankAccountId,
        toBankAccountId: bankAccountId === usdBankAccountId ? bankAccountId : bankAccountId,
        transferDate: '2026-04-01',
        amountMinor: '1000',
      })
      .expect(422);
    expect(res.body.code).toBe('SAME_ACCOUNT');
  });

  it('insists a cross-currency transfer states what was received', async () => {
    const res = await post('/api/v1/bank-transfers')
      .send({
        fromBankAccountId: bankAccountId,
        toBankAccountId: usdBankAccountId,
        transferDate: '2026-04-01',
        amountMinor: '709000',
      })
      .expect(422);
    expect(res.body.code).toBe('RECEIVED_AMOUNT_REQUIRED');
  });

  it('insists on a rate for the receiving leg', async () => {
    const res = await post('/api/v1/bank-transfers')
      .send({
        fromBankAccountId: bankAccountId,
        toBankAccountId: usdBankAccountId,
        transferDate: '2026-04-01',
        amountMinor: '709000',
        receivedAmountMinor: '100000',
      })
      .expect(422);
    expect(res.body.code).toBe('FX_RATE_REQUIRED');
  });

  it('posts a cross-currency transfer as one entry per currency plus the spread', async () => {
    // 709.000 JOD out, 1000.00 USD in at 0.700 JOD per USD = 700.000 JOD in.
    // The 9.000 JOD the bank kept is a realised FX loss, not a lost balance.
    const res = await post('/api/v1/bank-transfers')
      .send({
        fromBankAccountId: bankAccountId,
        toBankAccountId: usdBankAccountId,
        transferDate: '2026-04-01',
        amountMinor: '709000',
        receivedAmountMinor: '100000',
        fxRate: '0.700',
        memo: 'Fund the USD account',
      })
      .expect(201);

    expect(res.body.entryIds).toHaveLength(3);

    const seen = new Set<string>();
    for (const entryId of res.body.entryIds) {
      const entry = await client.get(`/api/v1/journal-entries/${entryId}`).expect(200);
      // Every entry balances on its own, in its own currency.
      expect(entry.body.totalDebit.amount).toBe(entry.body.totalCredit.amount);
      for (const l of entry.body.lines) seen.add(l.accountCode);
    }
    expect(seen).toContain('1120');
    expect(seen).toContain('1125');
    expect(seen).toContain('1190');
    expect(seen).toContain('5900');

    // The clearing account must net to zero in the base currency.
    const [clearing] = await owner<{ net: string }[]>`
      SELECT COALESCE(SUM(CASE WHEN l.side = 'debit' THEN l.base_amount_minor
                               ELSE -l.base_amount_minor END), 0)::text AS net
        FROM journal_lines l JOIN accounts a ON a.id = l.account_id
       WHERE a.code = '1190' AND l.tenant_id = ${tenantId}`;
    expect(clearing!.net).toBe('0');
  });
});

describe('reconciliation', () => {
  let sessionId: string;

  it('reports the difference while lines are still unmatched', async () => {
    const res = await post('/api/v1/reconciliations')
      .send({ bankAccountId, statementDate: '2026-01-31', statementClosingMinor: '1909000' })
      .expect(201);
    sessionId = res.body.id;
    expect(res.body.reconciled).toBe(false);
    expect(res.body.difference.minor).not.toBe('0');
  });

  it('refuses to complete while the account is out', async () => {
    const res = await post(`/api/v1/reconciliations/${sessionId}/complete`).expect(409);
    expect(res.body.code).toBe('NOT_RECONCILED');
  });

  it('completes once every line up to the statement date is matched', async () => {
    const lines = await client
      .get(`/api/v1/bank-accounts/${bankAccountId}/statement-lines`)
      .expect(200);
    for (const line of lines.body) {
      if (line.status === 'matched') continue;
      if (line.booking_date > '2026-01-31') continue;
      await post(`/api/v1/bank-statement-lines/${line.id}/categorise`)
        .send({ accountId: accounts.revenue, description: 'Identified on reconciliation' })
        .expect(201);
    }

    const status = await client.get(`/api/v1/reconciliations/${sessionId}`).expect(200);
    expect(status.body.reconciled).toBe(true);

    const completed = await post(`/api/v1/reconciliations/${sessionId}/complete`).expect(200);
    expect(completed.body.status).toBe('completed');
  });

  it('locks the cleared lines against re-matching', async () => {
    const lines = await client
      .get(`/api/v1/bank-accounts/${bankAccountId}/statement-lines`)
      .expect(200);
    const locked = lines.body.find((l: { locked: boolean }) => l.locked);
    expect(locked).toBeTruthy();

    // The database refuses it, not merely the service.
    await expect(
      owner`
        UPDATE bank_statement_lines SET status = 'unmatched', matched_entry_id = NULL
         WHERE id = ${locked.id}`,
    ).rejects.toThrow(/cleared in a completed reconciliation and is locked/);
  });

  it('refuses to reopen a completed reconciliation', async () => {
    await expect(
      owner`UPDATE reconciliation_sessions SET status = 'in_progress' WHERE id = ${sessionId}`,
    ).rejects.toThrow(/completed and cannot be reopened/);
  });
});

describe('the ledger still balances', () => {
  it('reports no imbalance after import, categorisation and transfers', async () => {
    const imbalances = await owner`SELECT * FROM ledger_verify(${tenantId}::uuid)`;
    expect(imbalances).toHaveLength(0);
  });
});
