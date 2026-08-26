import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import postgres from 'postgres';
import cookieParser from 'cookie-parser';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';

/** Inventory: costing, movements, the entries behind them, and valuation. */

let container: StartedPostgreSqlContainer;
let app: INestApplication;
let owner: postgres.Sql;
let client: request.Agent;
let csrf = '';

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');
const PASSWORD = 'Correct-Horse-Battery-9';
const EMAIL = 'stock@test.local';

let tenantId: string;
const acct: Record<string, string> = {};
let mainWarehouse = '';
let branchWarehouse = '';
let fifoItem = '';
let avgItem = '';
let stdItem = '';

function post(path: string): request.Test {
  return client.post(path).set('X-CSRF-Token', csrf);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('stock_test')
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
    INSERT INTO tenants (name, slug, base_currency) VALUES ('Stock Test','stock-test','JOD') RETURNING id`;
  tenantId = tenant!.id;
  await owner`
    INSERT INTO company_settings (tenant_id, legal_name, tax_number, address, base_currency)
    VALUES (${tenantId}, 'Demo Company LLC', '1234567', 'Amman, Jordan', 'JOD')`;

  const { AuthService } = await import('../src/auth/auth.service');
  const [user] = await owner<{ id: string }[]>`
    INSERT INTO users (tenant_id, email, display_name, password_hash)
    VALUES (${tenantId}, ${EMAIL}, 'Storekeeper', ${await AuthService.hashPassword(PASSWORD)})
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
      (${tenantId},'1150','Inventory','asset','inventory','debit'),
      (${tenantId},'2115','Goods Received Not Invoiced','liability','accrual','credit'),
      (${tenantId},'5100','Cost of Goods Sold','expense','cogs','debit'),
      (${tenantId},'5150','Purchase Price Variance','expense','other_expense','debit')
    RETURNING id, code`;
  for (const row of rows) acct[row.code] = row.id;

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: `postgresql://acct_app_user:app-secret@${container.getHost()}:${container.getPort()}/stock_test`,
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

  mainWarehouse = (
    await post('/api/v1/inventory/warehouses').send({ code: 'MAIN', name: 'Main Store' }).expect(201)
  ).body.id;
  branchWarehouse = (
    await post('/api/v1/inventory/warehouses').send({ code: 'BRANCH', name: 'Branch Store' }).expect(201)
  ).body.id;

  const item = (sku: string, method: string, extra: Record<string, unknown> = {}) =>
    post('/api/v1/inventory/items')
      .send({
        sku,
        name: sku,
        costingMethod: method,
        inventoryAccountId: acct['1150'],
        cogsAccountId: acct['5100'],
        ...extra,
      })
      .expect(201);

  fifoItem = (await item('WIDGET-F', 'fifo')).body.id;
  avgItem = (await item('WIDGET-A', 'weighted_average')).body.id;
  stdItem = (
    await item('WIDGET-S', 'standard', {
      standardCostMinor: '1000',
      varianceAccountId: acct['5150'],
    })
  ).body.id;
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await container?.stop();
});

async function receive(itemId: string, quantity: string, unitCostMinor: string, date = '2026-01-05') {
  return post('/api/v1/inventory/receipts')
    .set('Idempotency-Key', `r-${itemId}-${quantity}-${unitCostMinor}-${date}`)
    .send({
      itemId,
      warehouseId: mainWarehouse,
      quantity,
      unitCostMinor,
      movementDate: date,
      offsetAccountId: acct['2115'],
    });
}

async function issue(itemId: string, quantity: string, date = '2026-01-10') {
  return post('/api/v1/inventory/issues')
    .set('Idempotency-Key', `i-${itemId}-${quantity}-${date}`)
    .send({ itemId, warehouseId: mainWarehouse, quantity, movementDate: date });
}

describe('item setup', () => {
  it('refuses standard costing without a standard cost', async () => {
    const res = await post('/api/v1/inventory/items').send({
      sku: 'BAD-STD',
      name: 'Bad',
      costingMethod: 'standard',
      inventoryAccountId: acct['1150'],
      cogsAccountId: acct['5100'],
      varianceAccountId: acct['5150'],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('STANDARD_COST_REQUIRED');
  });
});

describe('FIFO', () => {
  it('receives stock and debits inventory with what was paid', async () => {
    const first = await receive(fifoItem, '10', '1000');
    expect(first.status).toBe(201);
    expect(first.body.cost.amount).toBe('10.000');

    const second = await receive(fifoItem, '10', '1200', '2026-01-06');
    expect(second.status).toBe(201);
    expect(second.body.onHand.quantity).toBe('20');
    expect(second.body.onHand.value.amount).toBe('22.000');

    const lines = await owner<{ code: string; side: string; amount: string }[]>`
      SELECT a.code, l.side, l.base_amount_minor::text AS amount
        FROM journal_lines l JOIN accounts a ON a.id = l.account_id
       WHERE l.entry_id = ${first.body.entryId} ORDER BY a.code`;
    expect(lines).toEqual([
      { code: '1150', side: 'debit', amount: '10000' },
      { code: '2115', side: 'credit', amount: '10000' },
    ]);
  });

  it('issues from the oldest layer first and posts cost of sales', async () => {
    const res = await issue(fifoItem, '12');
    expect(res.status).toBe(201);
    // 10 at 1.000 then 2 at 1.200.
    expect(res.body.cost.amount).toBe('12.400');
    expect(res.body.consumed).toHaveLength(2);
    expect(res.body.onHand.quantity).toBe('8');

    const lines = await owner<{ code: string; side: string; amount: string }[]>`
      SELECT a.code, l.side, l.base_amount_minor::text AS amount
        FROM journal_lines l JOIN accounts a ON a.id = l.account_id
       WHERE l.entry_id = ${res.body.entryId} ORDER BY a.code`;
    expect(lines).toEqual([
      { code: '1150', side: 'credit', amount: '12400' },
      { code: '5100', side: 'debit', amount: '12400' },
    ]);
  });

  it('records which layers an issue consumed', async () => {
    const consumptions = await owner<{ count: string }[]>`
      SELECT count(*)::text AS count FROM stock_layer_consumptions`;
    expect(Number(consumptions[0]!.count)).toBeGreaterThan(0);
  });

  it('refuses to issue more than is on hand', async () => {
    const res = await issue(fifoItem, '100', '2026-01-11');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INSUFFICIENT_STOCK');
  });

  it('replays an idempotent receipt rather than doubling the stock', async () => {
    const before = await client.get('/api/v1/inventory/valuation').expect(200);
    await post('/api/v1/inventory/receipts')
      .set('Idempotency-Key', 'r-fifo-replay')
      .send({
        itemId: fifoItem,
        warehouseId: mainWarehouse,
        quantity: '1',
        unitCostMinor: '1000',
        movementDate: '2026-01-12',
        offsetAccountId: acct['2115'],
      })
      .expect(201);
    const replay = await post('/api/v1/inventory/receipts')
      .set('Idempotency-Key', 'r-fifo-replay')
      .send({
        itemId: fifoItem,
        warehouseId: mainWarehouse,
        quantity: '1',
        unitCostMinor: '1000',
        movementDate: '2026-01-12',
        offsetAccountId: acct['2115'],
      })
      .expect(201);
    const after = await client.get('/api/v1/inventory/valuation').expect(200);
    expect(Number(after.body.totalValue.amount) - Number(before.body.totalValue.amount)).toBeCloseTo(1, 3);
    expect(replay.body.movementId).toBeTruthy();
  });
});

describe('weighted average', () => {
  it('re-averages on receipt and issues at the average', async () => {
    await receive(avgItem, '10', '1000', '2026-01-05');
    await receive(avgItem, '10', '1200', '2026-01-06');
    const res = await issue(avgItem, '5', '2026-01-10');
    expect(res.status).toBe(201);
    expect(res.body.cost.amount).toBe('5.500');
    expect(res.body.onHand.value.amount).toBe('16.500');
  });
});

describe('standard cost', () => {
  it('carries stock at standard and books the purchase price variance', async () => {
    const res = await receive(stdItem, '10', '1150', '2026-01-05');
    expect(res.status).toBe(201);
    expect(res.body.onHand.value.amount).toBe('10.000');

    const lines = await owner<{ code: string; side: string; amount: string }[]>`
      SELECT a.code, l.side, l.base_amount_minor::text AS amount
        FROM journal_lines l JOIN accounts a ON a.id = l.account_id
       WHERE l.entry_id = ${res.body.entryId} ORDER BY a.code`;
    expect(lines).toEqual([
      { code: '1150', side: 'debit', amount: '10000' },
      { code: '2115', side: 'credit', amount: '11500' },
      { code: '5150', side: 'debit', amount: '1500' },
    ]);
  });

  it('issues at standard whatever was paid', async () => {
    const res = await issue(stdItem, '4', '2026-01-10');
    expect(res.body.cost.amount).toBe('4.000');
  });
});

describe('transfers', () => {
  it('moves stock at the cost it left with and posts nothing', async () => {
    const res = await post('/api/v1/inventory/transfers')
      .send({
        itemId: fifoItem,
        fromWarehouseId: mainWarehouse,
        toWarehouseId: branchWarehouse,
        quantity: '2',
        movementDate: '2026-01-15',
      })
      .expect(201);
    expect(res.body.out.cost.amount).toBe(res.body.in.cost.amount);

    const valuation = await client.get('/api/v1/inventory/valuation').expect(200);
    const branch = valuation.body.items.find(
      (i: { warehouse: string; sku: string }) => i.warehouse === 'BRANCH' && i.sku === 'WIDGET-F',
    );
    expect(branch.quantity).toBe('2.000000');
  });

  it('refuses a transfer to the same warehouse', async () => {
    const res = await post('/api/v1/inventory/transfers').send({
      itemId: fifoItem,
      fromWarehouseId: mainWarehouse,
      toWarehouseId: mainWarehouse,
      quantity: '1',
      movementDate: '2026-01-15',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TRANSFER_SAME_WAREHOUSE');
  });
});

describe('valuation', () => {
  it('agrees with the inventory account in the ledger', async () => {
    const res = await client.get('/api/v1/inventory/valuation').expect(200);
    expect(res.body.agreesWithLedger).toBe(true);
    expect(res.body.totalValue.amount).toBe(res.body.ledgerInventoryValue.amount);
  });

  it('lists every movement with the entry behind it', async () => {
    const res = await client.get(`/api/v1/inventory/items/${fifoItem}/movements`).expect(200);
    expect(res.body.length).toBeGreaterThan(0);
    const receipts = res.body.filter((m: { kind: string }) => m.kind === 'receipt');
    expect(receipts.every((m: { entryId: string | null }) => m.entryId)).toBe(true);
  });

  it('rebuilds the same balances from the movements', async () => {
    const before = await owner<{ item_id: string; warehouse_id: string; quantity: string; value_minor: string }[]>`
      SELECT item_id, warehouse_id, quantity::text, value_minor::text FROM stock_balances
       ORDER BY item_id, warehouse_id`;
    await owner`SELECT rebuild_stock_balances(${tenantId}::uuid)`;
    const after = await owner<{ item_id: string; warehouse_id: string; quantity: string; value_minor: string }[]>`
      SELECT item_id, warehouse_id, quantity::text, value_minor::text FROM stock_balances
       ORDER BY item_id, warehouse_id`;
    expect(after).toEqual(before);
  });

  it('leaves the trial balance in balance', async () => {
    const tb = await client.get('/api/v1/reports/trial-balance?toDate=2026-01-31').expect(200);
    expect(tb.body.balanced).toBe(true);
  });
});
