import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import postgres from 'postgres';
import cookieParser from 'cookie-parser';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';

/**
 * Financial statements end to end. The fixture is posted through the ledger API
 * rather than inserted, so the statements are read from the same journal lines
 * the trial balance reads — if the two ever disagreed, this suite would say so.
 */

let container: StartedPostgreSqlContainer;
let app: INestApplication;
let owner: postgres.Sql;
let client: request.Agent;
let csrf = '';

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');
const PASSWORD = 'Correct-Horse-Battery-9';
const EMAIL = 'reports@test.local';

let tenantId: string;
let acct: Record<string, string> = {};

function post(path: string): request.Test {
  return client.post(path).set('X-CSRF-Token', csrf);
}

interface LineInput {
  accountId: string;
  side: 'debit' | 'credit';
  amountMinor: string;
}

async function postEntry(entryDate: string, memo: string, lines: LineInput[]): Promise<void> {
  await post('/api/v1/journal-entries')
    .set('Idempotency-Key', `${memo}-${entryDate}`)
    .send({ entryDate, memo, status: 'posted', lines })
    .expect(201);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('reports_test')
    .withUsername('owner')
    .withPassword('owner')
    .start();

  owner = postgres(container.getConnectionUri(), { max: 5, onnotice: () => {} });
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  for (const file of files) await owner.unsafe(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));

  await owner`INSERT INTO currencies (code, name, symbol, minor_unit_exponent) VALUES ('JOD','Jordanian Dinar','JD',3)`;
  const [tenant] = await owner<{ id: string }[]>`
    INSERT INTO tenants (name, slug, base_currency) VALUES ('Reports Test','reports-test','JOD') RETURNING id`;
  tenantId = tenant!.id;
  await owner`
    INSERT INTO company_settings (tenant_id, legal_name, tax_number, address, base_currency)
    VALUES (${tenantId}, 'Demo Company LLC', '1234567', 'Amman, Jordan', 'JOD')`;

  const { AuthService } = await import('../src/auth/auth.service');
  const [user] = await owner<{ id: string }[]>`
    INSERT INTO users (tenant_id, email, display_name, password_hash)
    VALUES (${tenantId}, ${EMAIL}, 'Report Reader', ${await AuthService.hashPassword(PASSWORD)})
    RETURNING id`;
  const [role] = await owner<{ id: string }[]>`
    INSERT INTO roles (tenant_id, code, name, is_system) VALUES (${tenantId},'all','All',true) RETURNING id`;
  await owner`INSERT INTO role_permissions (role_id, permission_code) SELECT ${role!.id}, code FROM permissions`;
  await owner`INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES (${user!.id}, ${role!.id}, ${tenantId})`;

  await owner.unsafe(`CREATE ROLE acct_app_user LOGIN PASSWORD 'app-secret' IN ROLE acct_app`);
  await owner`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO acct_app`;
  await owner`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO acct_app`;
  await owner`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO acct_app`;

  for (const [name, start, end] of [
    ['2025', '2025-01-01', '2025-12-31'],
    ['2026', '2026-01-01', '2026-12-31'],
  ] as const) {
    const [year] = await owner<{ id: string }[]>`
      INSERT INTO fiscal_years (tenant_id, name, start_date, end_date)
      VALUES (${tenantId}, ${name}, ${start}, ${end}) RETURNING id`;
    for (let month = 1; month <= 12; month += 1) {
      const y = Number(name);
      await owner`
        INSERT INTO fiscal_periods (tenant_id, fiscal_year_id, period_no, start_date, end_date)
        VALUES (${tenantId}, ${year!.id}, ${month},
                ${new Date(Date.UTC(y, month - 1, 1)).toISOString().slice(0, 10)},
                ${new Date(Date.UTC(y, month, 0)).toISOString().slice(0, 10)})`;
      }
    await owner`
      INSERT INTO number_sequences (tenant_id, doc_type, scope_key, prefix, padding)
      VALUES (${tenantId}, 'journal_entry', ${year!.id}, 'JE-', 5)`;
  }

  const rows = await owner<{ id: string; code: string }[]>`
    INSERT INTO accounts (tenant_id, code, name, type, subtype, normal_balance) VALUES
      (${tenantId},'1120','Bank','asset','bank','debit'),
      (${tenantId},'1130','Accounts Receivable','asset','receivable','debit'),
      (${tenantId},'1150','Inventory','asset','inventory','debit'),
      (${tenantId},'1510','Equipment','asset','fixed_asset','debit'),
      (${tenantId},'1590','Accumulated Depreciation','asset','accumulated_depreciation','debit'),
      (${tenantId},'2110','Accounts Payable','liability','payable','credit'),
      (${tenantId},'2410','Bank Loan','liability','long_term_liability','credit'),
      (${tenantId},'3010','Share Capital','equity','capital','credit'),
      (${tenantId},'4010','Sales Revenue','revenue','operating_revenue','credit'),
      (${tenantId},'5100','Cost of Goods Sold','expense','cogs','debit'),
      (${tenantId},'5220','Rent','expense','operating_expense','debit'),
      (${tenantId},'5260','Depreciation Expense','expense','depreciation','debit')
    RETURNING id, code`;
  for (const row of rows) acct[row.code] = row.id;

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: `postgresql://acct_app_user:app-secret@${container.getHost()}:${container.getPort()}/reports_test`,
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

  // Prior year: capital introduced, and a small profit so the comparative bites.
  await postEntry('2025-12-01', 'capital', [
    { accountId: acct['1120']!, side: 'debit', amountMinor: '100000' },
    { accountId: acct['3010']!, side: 'credit', amountMinor: '100000' },
  ]);
  await postEntry('2025-12-15', 'prior-year sale', [
    { accountId: acct['1120']!, side: 'debit', amountMinor: '800000' },
    { accountId: acct['4010']!, side: 'credit', amountMinor: '800000' },
  ]);

  // January 2026, the window under test.
  await postEntry('2026-01-05', 'sale on credit', [
    { accountId: acct['1130']!, side: 'debit', amountMinor: '1000000' },
    { accountId: acct['4010']!, side: 'credit', amountMinor: '1000000' },
  ]);
  await postEntry('2026-01-10', 'collection', [
    { accountId: acct['1120']!, side: 'debit', amountMinor: '400000' },
    { accountId: acct['1130']!, side: 'credit', amountMinor: '400000' },
  ]);
  await postEntry('2026-01-11', 'stock bought for cash', [
    { accountId: acct['1150']!, side: 'debit', amountMinor: '300000' },
    { accountId: acct['1120']!, side: 'credit', amountMinor: '300000' },
  ]);
  await postEntry('2026-01-20', 'cost of goods sold', [
    { accountId: acct['5100']!, side: 'debit', amountMinor: '300000' },
    { accountId: acct['1150']!, side: 'credit', amountMinor: '300000' },
  ]);
  await postEntry('2026-01-25', 'rent paid', [
    { accountId: acct['5220']!, side: 'debit', amountMinor: '100000' },
    { accountId: acct['1120']!, side: 'credit', amountMinor: '100000' },
  ]);
  await postEntry('2026-01-28', 'equipment bought', [
    { accountId: acct['1510']!, side: 'debit', amountMinor: '200000' },
    { accountId: acct['1120']!, side: 'credit', amountMinor: '200000' },
  ]);
  await postEntry('2026-01-29', 'loan drawn', [
    { accountId: acct['1120']!, side: 'debit', amountMinor: '150000' },
    { accountId: acct['2410']!, side: 'credit', amountMinor: '150000' },
  ]);
  await postEntry('2026-01-31', 'depreciation', [
    { accountId: acct['5260']!, side: 'debit', amountMinor: '50000' },
    { accountId: acct['1590']!, side: 'credit', amountMinor: '50000' },
  ]);
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await container?.stop();
});

const JAN = 'fromDate=2026-01-01&toDate=2026-01-31';

describe('income statement', () => {
  it('reports revenue, cost of sales and profit for the window only', async () => {
    const res = await client.get(`/api/v1/reports/income-statement?${JAN}`).expect(200);
    expect(res.body.revenue.total.amount).toBe('1000.000');
    expect(res.body.costOfSales.total.amount).toBe('300.000');
    expect(res.body.grossProfit.amount).toBe('700.000');
    expect(res.body.netProfit.amount).toBe('550.000');
  });

  it('reports the prior year alongside when a comparative window is given', async () => {
    const res = await client
      .get(`/api/v1/reports/income-statement?${JAN}&compareFromDate=2025-12-01&compareToDate=2025-12-31`)
      .expect(200);
    expect(res.body.comparative.netProfit.amount).toBe('800.000');
    expect(res.body.variance.netProfit.amount).toBe('-250.000');
  });

  it('exports the same figures as CSV', async () => {
    const res = await client.get(`/api/v1/reports/income-statement?${JAN}&format=csv`).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('"Revenue","4010","Sales Revenue","1000.000"');
  });
});

describe('balance sheet', () => {
  it('balances, and agrees with the profit on the income statement', async () => {
    const res = await client.get('/api/v1/reports/balance-sheet?asOfDate=2026-01-31').expect(200);
    expect(res.body.isBalanced).toBe(true);
    expect(res.body.totalAssets.amount).toBe(res.body.totalLiabilitiesAndEquity.amount);
    // Prior-year profit is not closed, so it sits in equity alongside this year's.
    expect(res.body.profitForPeriod.amount).toBe('1350.000');
    expect(res.body.nonCurrentAssets.total.amount).toBe('150.000');
  });

  it('refuses a date no fiscal year covers rather than guessing', async () => {
    const res = await client.get('/api/v1/reports/balance-sheet?asOfDate=2030-01-31').expect(422);
    expect(res.body.code).toBe('NO_FISCAL_YEAR');
  });
});

describe('cash flow statement', () => {
  it('reconciles operating, investing and financing to the movement in cash', async () => {
    const res = await client.get(`/api/v1/reports/cash-flow?${JAN}`).expect(200);
    expect(res.body.reconciles).toBe(true);
    expect(res.body.operating.netProfit.amount).toBe('550.000');
    expect(res.body.operating.nonCashAdjustments.total.amount).toBe('50.000');
    expect(res.body.investing.total.amount).toBe('-200.000');
    expect(res.body.financing.total.amount).toBe('150.000');
    expect(res.body.openingCash.amount).toBe('900.000');
    expect(res.body.closingCash.amount).toBe('850.000');
    expect(res.body.netMovement.amount).toBe('-50.000');
  });
});

describe('statement of changes in equity', () => {
  it('opens at prior equity and closes at the balance sheet figure', async () => {
    const equity = await client.get(`/api/v1/reports/equity?${JAN}`).expect(200);
    const bs = await client.get('/api/v1/reports/balance-sheet?asOfDate=2026-01-31').expect(200);
    expect(equity.body.openingEquity.amount).toBe('100.000');
    expect(equity.body.profitForPeriod.amount).toBe('550.000');
    expect(equity.body.closingEquity.amount).toBe('650.000');
    // The balance sheet also carries the prior year's unclosed profit.
    expect(bs.body.equity.total.amount).toBe('1450.000');
  });
});

describe('trial balance agreement', () => {
  it('reports the same profit the trial balance implies', async () => {
    const tb = await client.get('/api/v1/reports/trial-balance?toDate=2026-01-31').expect(200);
    expect(tb.body.totalDebit.amount).toBe(tb.body.totalCredit.amount);
    const pl = await client.get(`/api/v1/reports/income-statement?${JAN}`).expect(200);
    expect(pl.body.netProfit.amount).toBe('550.000');
  });
});
