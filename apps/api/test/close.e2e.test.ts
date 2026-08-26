import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import postgres from 'postgres';
import cookieParser from 'cookie-parser';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';

/** Period close: soft and hard close, the checklist, accruals, FX revaluation, year end. */

let container: StartedPostgreSqlContainer;
let app: INestApplication;
let owner: postgres.Sql;
let client: request.Agent;
let csrf = '';

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');
const PASSWORD = 'Correct-Horse-Battery-9';
const EMAIL = 'close@test.local';

let tenantId: string;
let yearId: string;
const periods: Record<number, string> = {};
const acct: Record<string, string> = {};

function post(path: string): request.Test {
  return client.post(path).set('X-CSRF-Token', csrf);
}
function put(path: string): request.Test {
  return client.put(path).set('X-CSRF-Token', csrf);
}

async function postEntry(
  entryDate: string,
  memo: string,
  lines: { accountId: string; side: 'debit' | 'credit'; amountMinor: string; currencyCode?: string; fxRate?: string }[],
): Promise<request.Response> {
  return post('/api/v1/journal-entries')
    .set('Idempotency-Key', `${memo}-${entryDate}`)
    .send({ entryDate, memo, status: 'posted', lines });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('close_test')
    .withUsername('owner')
    .withPassword('owner')
    .start();

  owner = postgres(container.getConnectionUri(), { max: 5, onnotice: () => {} });
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  for (const file of files) await owner.unsafe(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));

  await owner`
    INSERT INTO currencies (code, name, symbol, minor_unit_exponent) VALUES
      ('JOD','Jordanian Dinar','JD',3), ('USD','US Dollar','$',2)`;
  const [tenant] = await owner<{ id: string }[]>`
    INSERT INTO tenants (name, slug, base_currency) VALUES ('Close Test','close-test','JOD') RETURNING id`;
  tenantId = tenant!.id;
  await owner`
    INSERT INTO company_settings (tenant_id, legal_name, tax_number, address, base_currency)
    VALUES (${tenantId}, 'Demo Company LLC', '1234567', 'Amman, Jordan', 'JOD')`;

  const { AuthService } = await import('../src/auth/auth.service');
  const [user] = await owner<{ id: string }[]>`
    INSERT INTO users (tenant_id, email, display_name, password_hash)
    VALUES (${tenantId}, ${EMAIL}, 'Closer', ${await AuthService.hashPassword(PASSWORD)})
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
  yearId = year!.id;
  for (let month = 1; month <= 12; month += 1) {
    const [period] = await owner<{ id: string }[]>`
      INSERT INTO fiscal_periods (tenant_id, fiscal_year_id, period_no, start_date, end_date)
      VALUES (${tenantId}, ${yearId}, ${month},
              ${new Date(Date.UTC(2026, month - 1, 1)).toISOString().slice(0, 10)},
              ${new Date(Date.UTC(2026, month, 0)).toISOString().slice(0, 10)})
      RETURNING id`;
    periods[month] = period!.id;
  }
  await owner`
    INSERT INTO number_sequences (tenant_id, doc_type, scope_key, prefix, padding)
    VALUES (${tenantId}, 'journal_entry', ${yearId}, 'JE-', 5)`;

  const rows = await owner<{ id: string; code: string }[]>`
    INSERT INTO accounts (tenant_id, code, name, type, subtype, normal_balance) VALUES
      (${tenantId},'1120','Bank','asset','bank','debit'),
      (${tenantId},'1130','Accounts Receivable','asset','receivable','debit'),
      (${tenantId},'1160','Prepaid Expenses','asset','prepaid','debit'),
      (${tenantId},'2150','Accrued Expenses','liability','accrual','credit'),
      (${tenantId},'3020','Retained Earnings','equity','retained_earnings','credit'),
      (${tenantId},'4010','Sales Revenue','revenue','operating_revenue','credit'),
      (${tenantId},'4900','Unrealised FX Gain','revenue','other_income','credit'),
      (${tenantId},'5220','Rent','expense','operating_expense','debit'),
      (${tenantId},'5900','Unrealised FX Loss','expense','other_expense','debit')
    RETURNING id, code`;
  for (const row of rows) acct[row.code] = row.id;

  await owner`
    INSERT INTO exchange_rates (tenant_id, from_currency, to_currency, rate, rate_date)
    VALUES (${tenantId},'USD','JOD',0.7100000000,'2026-01-31')`;

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: `postgresql://acct_app_user:app-secret@${container.getHost()}:${container.getPort()}/close_test`,
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

  // January trading, plus a USD receivable booked at 0.700 to revalue later.
  await postEntry('2026-01-10', 'sale', [
    { accountId: acct['1120']!, side: 'debit', amountMinor: '1000000' },
    { accountId: acct['4010']!, side: 'credit', amountMinor: '1000000' },
  ]).then((r) => expect(r.status).toBe(201));
  await postEntry('2026-01-15', 'rent', [
    { accountId: acct['5220']!, side: 'debit', amountMinor: '200000' },
    { accountId: acct['1120']!, side: 'credit', amountMinor: '200000' },
  ]).then((r) => expect(r.status).toBe(201));
  await postEntry('2026-01-20', 'usd sale', [
    { accountId: acct['1130']!, side: 'debit', amountMinor: '100000', currencyCode: 'USD', fxRate: '7' },
    // Both legs in USD: an entry must balance within each currency it touches.
    { accountId: acct['4010']!, side: 'credit', amountMinor: '100000', currencyCode: 'USD', fxRate: '7' },
  ]).then((r) => expect(r.status).toBe(201));
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await container?.stop();
});

describe('close checklist', () => {
  it('seeds a checklist on first read and reports outstanding drafts', async () => {
    const res = await client.get(`/api/v1/fiscal-periods/${periods[1]}/close-status`).expect(200);
    expect(res.body.status).toBe('open');
    expect(res.body.checklist.length).toBeGreaterThan(0);
    expect(res.body.checklist.every((i: { status: string }) => i.status === 'pending')).toBe(true);
    expect(res.body.draftEntries).toBe(0);
  });

  it('refuses to skip an item without a reason', async () => {
    const res = await put(`/api/v1/fiscal-periods/${periods[1]}/checklist/fx_revalued`)
      .send({ status: 'skipped' })
      .expect(422);
    expect(res.body.code).toBe('SKIP_NEEDS_REASON');
  });

  it('blocks a hard close while blocking items are outstanding', async () => {
    const res = await post(`/api/v1/fiscal-periods/${periods[1]}/status`)
      .send({ status: 'closed' })
      .expect(409);
    expect(res.body.code).toBe('CHECKLIST_INCOMPLETE');
  });
});

describe('soft close', () => {
  it('accepts adjustments but refuses ordinary postings', async () => {
    await post(`/api/v1/fiscal-periods/${periods[1]}/status`).send({ status: 'soft_closed' }).expect(201);

    const ordinary = await postEntry('2026-01-25', 'late sale', [
      { accountId: acct['1120']!, side: 'debit', amountMinor: '1000' },
      { accountId: acct['4010']!, side: 'credit', amountMinor: '1000' },
    ]);
    expect(ordinary.status).toBe(409);
    expect(ordinary.body.code).toBe('PERIOD_SOFT_CLOSED');

    const adjustment = await post('/api/v1/journal-entries')
      .set('Idempotency-Key', 'adjustment-jan')
      .send({
        entryDate: '2026-01-26',
        memo: 'reclassification',
        status: 'posted',
        isAdjustment: true,
        lines: [
          { accountId: acct['5220']!, side: 'debit', amountMinor: '1000' },
          { accountId: acct['1120']!, side: 'credit', amountMinor: '1000' },
        ],
      });
    expect(adjustment.status).toBe(201);
  });
});

describe('accruals and prepayments', () => {
  it('posts the accrual and its reversal together', async () => {
    const res = await post('/api/v1/close/accruals')
      .send({
        kind: 'accrual',
        memo: 'January electricity, invoice not yet received',
        amountMinor: '250000',
        plAccountId: acct['5220'],
        balanceAccountId: acct['2150'],
        accrualDate: '2026-01-31',
        reversalDate: '2026-02-01',
      })
      .expect(201);
    expect(res.body.accrualEntryId).toBeTruthy();
    expect(res.body.reversalEntryId).toBeTruthy();

    const list = await client.get('/api/v1/close/accruals').expect(200);
    expect(list.body[0].amount.amount).toBe('250.000');
  });

  it('refuses a reversal dated before the accrual', async () => {
    const res = await post('/api/v1/close/accruals')
      .send({
        kind: 'prepayment',
        memo: 'backwards',
        amountMinor: '1000',
        plAccountId: acct['5220'],
        balanceAccountId: acct['1160'],
        accrualDate: '2026-01-31',
        reversalDate: '2026-01-30',
      })
      .expect(422);
    expect(res.body.code).toBe('REVERSAL_NOT_AFTER_ACCRUAL');
  });
});

describe('FX revaluation', () => {
  it('restates the USD receivable at the closing rate and books the gain', async () => {
    const res = await post('/api/v1/close/fx-revaluation').send({ asOfDate: '2026-01-31' }).expect(201);
    // USD 1,000.00 booked at 0.700 = 700.000, restated at 0.710 = 710.000.
    expect(res.body.netGain.amount).toBe('10.000');
    expect(res.body.entryId).toBeTruthy();
  });

  it('refuses to revalue the same date twice', async () => {
    const res = await post('/api/v1/close/fx-revaluation').send({ asOfDate: '2026-01-31' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('leaves the trial balance in balance', async () => {
    const tb = await client.get('/api/v1/reports/trial-balance?toDate=2026-01-31').expect(200);
    expect(tb.body.balanced).toBe(true);
  });
});

describe('hard close', () => {
  it('closes January once the checklist is resolved', async () => {
    const status = await client.get(`/api/v1/fiscal-periods/${periods[1]}/close-status`).expect(200);
    for (const item of status.body.checklist as { itemCode: string }[]) {
      await put(`/api/v1/fiscal-periods/${periods[1]}/checklist/${item.itemCode}`)
        .send({ status: 'done' })
        .expect(200);
    }
    const closed = await post(`/api/v1/fiscal-periods/${periods[1]}/status`)
      .send({ status: 'closed' })
      .expect(201);
    expect(closed.body.status).toBe('closed');
  });

  it('refuses every posting into a closed period, adjustments included', async () => {
    const res = await post('/api/v1/journal-entries')
      .set('Idempotency-Key', 'post-close-adjustment')
      .send({
        entryDate: '2026-01-27',
        memo: 'too late',
        status: 'posted',
        isAdjustment: true,
        lines: [
          { accountId: acct['5220']!, side: 'debit', amountMinor: '1000' },
          { accountId: acct['1120']!, side: 'credit', amountMinor: '1000' },
        ],
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PERIOD_CLOSED');
  });

  it('refuses to close March while February is still open', async () => {
    const res = await post(`/api/v1/fiscal-periods/${periods[3]}/status`).send({ status: 'closed' });
    expect(res.status).toBe(409);
    expect(['EARLIER_PERIOD_OPEN', 'CHECKLIST_INCOMPLETE']).toContain(res.body.code);
  });
});

describe('year end', () => {
  it('refuses to close the year while periods are open', async () => {
    const res = await post(`/api/v1/close/fiscal-years/${yearId}/status`).send({ status: 'closed' });
    expect(res.status).toBe(409);
    expect(['PERIODS_NOT_CLOSED', 'CLOSING_ENTRY_MISSING']).toContain(res.body.code);
  });

  it('posts a closing entry that zeroes profit and loss into retained earnings', async () => {
    const res = await post(`/api/v1/close/fiscal-years/${yearId}/closing-entry`).expect(201);
    expect(res.body.entryId).toBeTruthy();
    const profit = Number(res.body.profit.amount);
    expect(Number.isFinite(profit)).toBe(true);

    const pl = await client
      .get('/api/v1/reports/income-statement?fromDate=2026-01-01&toDate=2026-12-31')
      .expect(200);
    // After closing, the year's profit and loss accounts net to nothing.
    expect(pl.body.netProfit.amount).toBe('0.000');

    const tb = await client.get('/api/v1/reports/trial-balance?toDate=2026-12-31').expect(200);
    expect(tb.body.balanced).toBe(true);
  });

  it('refuses a second closing entry for the same year', async () => {
    const res = await post(`/api/v1/close/fiscal-years/${yearId}/closing-entry`);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
