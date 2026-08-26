import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import postgres from 'postgres';
import cookieParser from 'cookie-parser';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';

/** Budgeting: spreading a year, approving a baseline, and variance against actual. */

let container: StartedPostgreSqlContainer;
let app: INestApplication;
let owner: postgres.Sql;
let client: request.Agent;
let csrf = '';

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');
const PASSWORD = 'Correct-Horse-Battery-9';
const EMAIL = 'budget@test.local';

let tenantId: string;
let yearId: string;
let budgetId = '';
const acct: Record<string, string> = {};

function post(path: string): request.Test {
  return client.post(path).set('X-CSRF-Token', csrf);
}
function put(path: string): request.Test {
  return client.put(path).set('X-CSRF-Token', csrf);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('budget_test')
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
    INSERT INTO tenants (name, slug, base_currency) VALUES ('Budget Test','budget-test','JOD') RETURNING id`;
  tenantId = tenant!.id;
  await owner`
    INSERT INTO company_settings (tenant_id, legal_name, tax_number, address, base_currency)
    VALUES (${tenantId}, 'Demo Company LLC', '1234567', 'Amman, Jordan', 'JOD')`;

  const { AuthService } = await import('../src/auth/auth.service');
  const [user] = await owner<{ id: string }[]>`
    INSERT INTO users (tenant_id, email, display_name, password_hash)
    VALUES (${tenantId}, ${EMAIL}, 'Planner', ${await AuthService.hashPassword(PASSWORD)})
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
    await owner`
      INSERT INTO fiscal_periods (tenant_id, fiscal_year_id, period_no, start_date, end_date)
      VALUES (${tenantId}, ${yearId}, ${month},
              ${new Date(Date.UTC(2026, month - 1, 1)).toISOString().slice(0, 10)},
              ${new Date(Date.UTC(2026, month, 0)).toISOString().slice(0, 10)})`;
  }
  await owner`
    INSERT INTO number_sequences (tenant_id, doc_type, scope_key, prefix, padding)
    VALUES (${tenantId}, 'journal_entry', ${yearId}, 'JE-', 5)`;

  const rows = await owner<{ id: string; code: string }[]>`
    INSERT INTO accounts (tenant_id, code, name, type, subtype, normal_balance) VALUES
      (${tenantId},'1120','Bank','asset','bank','debit'),
      (${tenantId},'4010','Sales Revenue','revenue','operating_revenue','credit'),
      (${tenantId},'5220','Rent','expense','operating_expense','debit')
    RETURNING id, code`;
  for (const row of rows) acct[row.code] = row.id;

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: `postgresql://acct_app_user:app-secret@${container.getHost()}:${container.getPort()}/budget_test`,
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

  // January actuals: sales 900.000 against a 1,000.000 plan, rent 250.000 against 200.000.
  const entry = async (memo: string, lines: unknown[]) =>
    post('/api/v1/journal-entries')
      .set('Idempotency-Key', memo)
      .send({ entryDate: '2026-01-15', memo, status: 'posted', lines })
      .expect(201);

  await entry('sales', [
    { accountId: acct['1120'], side: 'debit', amountMinor: '900000' },
    { accountId: acct['4010'], side: 'credit', amountMinor: '900000' },
  ]);
  await entry('rent', [
    { accountId: acct['5220'], side: 'debit', amountMinor: '250000' },
    { accountId: acct['1120'], side: 'credit', amountMinor: '250000' },
  ]);
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await container?.stop();
});

describe('budgets', () => {
  it('creates a draft budget for the year', async () => {
    const res = await post('/api/v1/budgets').send({ name: '2026 Plan', fiscalYearId: yearId }).expect(201);
    budgetId = res.body.id;
    expect(res.body.status).toBe('draft');
  });

  it('spreads an annual figure across the twelve periods', async () => {
    const res = await put(`/api/v1/budgets/${budgetId}/accounts`)
      .send({ accountId: acct['4010'], annualAmountMinor: '12000000' })
      .expect(200);
    expect(res.body.lines).toHaveLength(12);
    const total = res.body.lines.reduce(
      (sum: bigint, l: { amountMinor: string }) => sum + BigInt(l.amountMinor),
      0n,
    );
    expect(total.toString()).toBe('12000000');
  });

  it('accepts a weighted spread for a year that is not flat', async () => {
    const res = await put(`/api/v1/budgets/${budgetId}/accounts`)
      .send({
        accountId: acct['5220'],
        annualAmountMinor: '2400000',
        method: 'weighted',
        weights: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      })
      .expect(200);
    expect(res.body.lines[0].amountMinor).toBe('200000');
  });
});

describe('variance', () => {
  it('reads revenue short of budget and expense over it as unfavourable', async () => {
    const res = await client
      .get(`/api/v1/budgets/${budgetId}/variance?fromDate=2026-01-01&toDate=2026-01-31`)
      .expect(200);

    const sales = res.body.lines.find((l: { code: string }) => l.code === '4010');
    expect(sales.budget.amount).toBe('1000.000');
    expect(sales.actual.amount).toBe('900.000');
    expect(sales.variance.amount).toBe('-100.000');
    expect(sales.isFavourable).toBe(false);

    const rent = res.body.lines.find((l: { code: string }) => l.code === '5220');
    expect(rent.variance.amount).toBe('50.000');
    expect(rent.isFavourable).toBe(false);
  });
});

describe('approval', () => {
  it('approves the budget and then refuses to change its lines', async () => {
    await post(`/api/v1/budgets/${budgetId}/approve`).expect(201);

    const res = await put(`/api/v1/budgets/${budgetId}/accounts`).send({
      accountId: acct['5220'],
      annualAmountMinor: '999000',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BUDGET_APPROVED');
  });

  it('refuses to approve twice', async () => {
    const res = await post(`/api/v1/budgets/${budgetId}/approve`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BUDGET_NOT_DRAFT');
  });
});
