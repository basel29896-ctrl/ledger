import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import postgres from 'postgres';
import cookieParser from 'cookie-parser';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';

/** Fixed assets: register, schedules, depreciation runs and disposal. */

let container: StartedPostgreSqlContainer;
let app: INestApplication;
let owner: postgres.Sql;
let client: request.Agent;
let csrf = '';

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');
const PASSWORD = 'Correct-Horse-Battery-9';
const EMAIL = 'assets@test.local';

let tenantId: string;
const acct: Record<string, string> = {};
let vanId = '';

function post(path: string): request.Test {
  return client.post(path).set('X-CSRF-Token', csrf);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('assets_test')
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
    INSERT INTO tenants (name, slug, base_currency) VALUES ('Assets Test','assets-test','JOD') RETURNING id`;
  tenantId = tenant!.id;
  await owner`
    INSERT INTO company_settings (tenant_id, legal_name, tax_number, address, base_currency)
    VALUES (${tenantId}, 'Demo Company LLC', '1234567', 'Amman, Jordan', 'JOD')`;

  const { AuthService } = await import('../src/auth/auth.service');
  const [user] = await owner<{ id: string }[]>`
    INSERT INTO users (tenant_id, email, display_name, password_hash)
    VALUES (${tenantId}, ${EMAIL}, 'Asset Keeper', ${await AuthService.hashPassword(PASSWORD)})
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
  await owner`
    INSERT INTO number_sequences (tenant_id, doc_type, scope_key, prefix, padding)
    VALUES (${tenantId}, 'journal_entry', ${year!.id}, 'JE-', 5)`;

  const rows = await owner<{ id: string; code: string }[]>`
    INSERT INTO accounts (tenant_id, code, name, type, subtype, normal_balance) VALUES
      (${tenantId},'1120','Bank','asset','bank','debit'),
      (${tenantId},'1510','Motor Vehicles','asset','fixed_asset','debit'),
      (${tenantId},'1590','Accumulated Depreciation','asset','accumulated_depreciation','debit'),
      (${tenantId},'4910','Gain on Disposal','revenue','other_income','credit'),
      (${tenantId},'5260','Depreciation Expense','expense','depreciation','debit'),
      (${tenantId},'5910','Loss on Disposal','expense','other_expense','debit')
    RETURNING id, code`;
  for (const row of rows) acct[row.code] = row.id;

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: `postgresql://acct_app_user:app-secret@${container.getHost()}:${container.getPort()}/assets_test`,
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

  // A van: 12,000.000 over five years, no residual.
  vanId = (
    await post('/api/v1/assets')
      .send({
        assetNo: 'FA-0001',
        name: 'Delivery Van',
        category: 'Vehicles',
        costMinor: '12000000',
        method: 'straight_line',
        usefulLifeMonths: 60,
        acquiredOn: '2026-01-01',
        inServiceOn: '2026-01-01',
        assetAccountId: acct['1510'],
        accumulatedAccountId: acct['1590'],
        depreciationExpenseAccountId: acct['5260'],
        disposalGainAccountId: acct['4910'],
        disposalLossAccountId: acct['5910'],
      })
      .expect(201)
  ).body.id;
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await container?.stop();
});

describe('register', () => {
  it('adds an asset in service with nothing depreciated yet', async () => {
    const res = await client.get('/api/v1/assets/register').expect(200);
    expect(res.body.totalCost.amount).toBe('12000.000');
    expect(res.body.totalAccumulated.amount).toBe('0.000');
    expect(res.body.totalNetBookValue.amount).toBe('12000.000');
  });

  it('refuses a reducing balance asset with no rate', async () => {
    const res = await post('/api/v1/assets').send({
      assetNo: 'FA-BAD',
      name: 'No rate',
      costMinor: '1000',
      method: 'reducing_balance',
      usefulLifeMonths: 12,
      acquiredOn: '2026-01-01',
      inServiceOn: '2026-01-01',
      assetAccountId: acct['1510'],
      accumulatedAccountId: acct['1590'],
      depreciationExpenseAccountId: acct['5260'],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('RATE_REQUIRED');
  });
});

describe('schedule', () => {
  it('shows the whole life and depreciates to exactly zero', async () => {
    const res = await client.get(`/api/v1/assets/${vanId}/schedule`).expect(200);
    expect(res.body.rows).toHaveLength(60);
    expect(res.body.rows[0].chargeMinor).toBe('200000');
    expect(res.body.rows[59].closingNetBookValueMinor).toBe('0');
  });
});

describe('depreciation run', () => {
  it('charges every asset and posts one entry for the period', async () => {
    const res = await post('/api/v1/assets/depreciation-runs')
      .send({ periodEnd: '2026-01-31' })
      .expect(201);
    expect(res.body.totalCharge.amount).toBe('200.000');
    expect(res.body.charges).toHaveLength(1);

    const lines = await owner<{ code: string; side: string; amount: string }[]>`
      SELECT a.code, l.side, l.base_amount_minor::text AS amount
        FROM journal_lines l JOIN accounts a ON a.id = l.account_id
       WHERE l.entry_id = ${res.body.entryId} ORDER BY a.code`;
    expect(lines).toEqual([
      { code: '1590', side: 'credit', amount: '200000' },
      { code: '5260', side: 'debit', amount: '200000' },
    ]);
  });

  it('refuses to run the same period twice', async () => {
    const res = await post('/api/v1/assets/depreciation-runs').send({ periodEnd: '2026-01-31' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PERIOD_ALREADY_DEPRECIATED');
  });

  it('carries the accumulated depreciation forward into the next run', async () => {
    const res = await post('/api/v1/assets/depreciation-runs')
      .send({ periodEnd: '2026-02-28' })
      .expect(201);
    expect(res.body.charges[0].accumulatedAfter.amount).toBe('400.000');

    const register = await client.get('/api/v1/assets/register').expect(200);
    expect(register.body.totalAccumulated.amount).toBe('400.000');
    expect(register.body.totalNetBookValue.amount).toBe('11600.000');
  });
});

describe('disposal', () => {
  it('removes cost and accumulated depreciation and books the loss', async () => {
    // Net book value is 11,600.000; sold for 11,000.000, so a 600.000 loss.
    const res = await post(`/api/v1/assets/${vanId}/disposal`)
      .send({
        disposedOn: '2026-03-15',
        proceedsMinor: '11000000',
        proceedsAccountId: acct['1120'],
      })
      .expect(201);
    expect(res.body.netBookValue.amount).toBe('11600.000');
    expect(res.body.gainOrLoss.amount).toBe('-600.000');
    expect(res.body.isGain).toBe(false);

    const lines = await owner<{ code: string; side: string; amount: string }[]>`
      SELECT a.code, l.side, l.base_amount_minor::text AS amount
        FROM journal_lines l JOIN accounts a ON a.id = l.account_id
       WHERE l.entry_id = ${res.body.entryId} ORDER BY a.code`;
    expect(lines).toEqual([
      { code: '1120', side: 'debit', amount: '11000000' },
      { code: '1510', side: 'credit', amount: '12000000' },
      { code: '1590', side: 'debit', amount: '400000' },
      { code: '5910', side: 'debit', amount: '600000' },
    ]);
  });

  it('leaves nothing on the balance sheet for a disposed asset', async () => {
    const register = await client.get('/api/v1/assets/register').expect(200);
    expect(register.body.totalNetBookValue.amount).toBe('0.000');
  });

  it('refuses a second disposal', async () => {
    const res = await post(`/api/v1/assets/${vanId}/disposal`).send({
      disposedOn: '2026-03-20',
      proceedsMinor: '1000',
      proceedsAccountId: acct['1120'],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ASSET_ALREADY_DISPOSED');
  });

  it('stops depreciating a disposed asset', async () => {
    const res = await post('/api/v1/assets/depreciation-runs')
      .send({ periodEnd: '2026-03-31' })
      .expect(201);
    expect(res.body.charges).toHaveLength(0);
    expect(res.body.entryId).toBeNull();
  });

  it('leaves the trial balance in balance', async () => {
    const tb = await client.get('/api/v1/reports/trial-balance?toDate=2026-03-31').expect(200);
    expect(tb.body.balanced).toBe(true);
  });
});
