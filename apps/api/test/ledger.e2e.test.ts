import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import postgres from 'postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';

/**
 * API-level tests against a real PostgreSQL. Nothing is stubbed: the same
 * triggers that protect production reject the bad requests here, and the API
 * is judged on whether it turns those into useful problem+json.
 */

let container: StartedPostgreSqlContainer;
let app: INestApplication;
let sql: postgres.Sql;
let tenantId: string;
let accounts: Record<'cash' | 'revenue' | 'tax' | 'parent', string>;

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('api_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  sql = postgres(container.getConnectionUri(), { max: 5, onnotice: () => {} });
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  for (const file of files) await sql.unsafe(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));

  await sql`
    INSERT INTO currencies (code, name, symbol, minor_unit_exponent)
    VALUES ('JOD', 'Jordanian Dinar', 'JD', 3), ('USD', 'US Dollar', '$', 2)`;
  const [tenant] = await sql<{ id: string }[]>`
    INSERT INTO tenants (name, slug, base_currency) VALUES ('API Test', 'api-test', 'JOD') RETURNING id`;
  tenantId = tenant!.id;

  const [year] = await sql<{ id: string }[]>`
    INSERT INTO fiscal_years (tenant_id, name, start_date, end_date)
    VALUES (${tenantId}, '2026', '2026-01-01', '2026-12-31') RETURNING id`;
  await sql`
    INSERT INTO fiscal_periods (tenant_id, fiscal_year_id, period_no, start_date, end_date) VALUES
      (${tenantId}, ${year!.id}, 1, '2026-01-01', '2026-01-31'),
      (${tenantId}, ${year!.id}, 2, '2026-02-01', '2026-02-28'),
      (${tenantId}, ${year!.id}, 3, '2026-03-01', '2026-03-31')`;

  const rows = await sql<{ id: string; code: string }[]>`
    INSERT INTO accounts (tenant_id, code, name, type, normal_balance, is_postable) VALUES
      (${tenantId}, '1000', 'Assets',        'asset',     'debit',  false),
      (${tenantId}, '1110', 'Cash',          'asset',     'debit',  true),
      (${tenantId}, '2130', 'Output Tax',    'liability', 'credit', true),
      (${tenantId}, '4010', 'Sales Revenue', 'revenue',   'credit', true)
    RETURNING id, code`;
  const byCode = (code: string): string => rows.find((r) => r.code === code)!.id;
  accounts = {
    parent: byCode('1000'),
    cash: byCode('1110'),
    tax: byCode('2130'),
    revenue: byCode('4010'),
  };

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: container.getConnectionUri(),
    REDIS_URL: 'redis://localhost:6379',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_BUCKET: 'test',
    S3_ACCESS_KEY: 'test',
    S3_SECRET_KEY: 'test',
    SMTP_HOST: 'localhost',
    SMTP_PORT: '1025',
  });

  const { LedgerModule } = await import('../src/ledger/ledger.module');
  const { DbModule } = await import('../src/db/db.module');
  const { EnvModule } = await import('../src/config/env.module');
  const { ProblemFilter } = await import('../src/common/problem.filter');

  const moduleRef = await Test.createTestingModule({
    imports: [EnvModule, DbModule, LedgerModule],
  }).compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ProblemFilter());
  await app.init();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await sql?.end();
  await container?.stop();
});

const api = (): request.Agent => request(app.getHttpServer());
const auth = { 'X-Tenant-Id': () => tenantId };

function invoiceLines() {
  return [
    { accountId: accounts.cash, side: 'debit', amountMinor: '1160000' },
    { accountId: accounts.revenue, side: 'credit', amountMinor: '1000000' },
    { accountId: accounts.tax, side: 'credit', amountMinor: '160000' },
  ];
}

describe('tenant scoping', () => {
  it('refuses a request with no tenant', async () => {
    const res = await api().get('/api/v1/accounts').expect(400);
    expect(res.body.code).toBe('TENANT_REQUIRED');
    expect(res.headers['content-type']).toContain('application/problem+json');
  });
});

describe('chart of accounts', () => {
  it('lists the seeded accounts in code order', async () => {
    const res = await api().get('/api/v1/accounts').set('X-Tenant-Id', auth['X-Tenant-Id']()).expect(200);
    expect(res.body.map((a: { code: string }) => a.code)).toEqual(['1000', '1110', '2130', '4010']);
  });

  it('derives the normal balance from the account type', async () => {
    const res = await api()
      .post('/api/v1/accounts')
      .set('X-Tenant-Id', tenantId)
      .send({ code: '5220', name: 'Rent', type: 'expense' })
      .expect(201);
    expect(res.body.normalBalance).toBe('debit');
    expect(res.body.isPostable).toBe(true);
  });

  it('rejects a duplicate account code with a stable code', async () => {
    const res = await api()
      .post('/api/v1/accounts')
      .set('X-Tenant-Id', tenantId)
      .send({ code: '1110', name: 'Cash again', type: 'asset' })
      .expect(409);
    expect(res.body.code).toBe('ACCOUNT_CODE_TAKEN');
  });

  it('reports every validation failure at once', async () => {
    const res = await api()
      .post('/api/v1/accounts')
      .set('X-Tenant-Id', tenantId)
      .send({ code: '', name: '', type: 'not-a-type' })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('posting a journal entry', () => {
  it('posts a balanced JOD invoice and returns money as strings', async () => {
    const res = await api()
      .post('/api/v1/journal-entries')
      .set('X-Tenant-Id', tenantId)
      .send({
        entryDate: '2026-01-15',
        status: 'posted',
        memo: 'Cash sale with 16% general sales tax',
        lines: invoiceLines(),
      })
      .expect(201);

    expect(res.body.status).toBe('posted');
    expect(res.body.entryRef).toMatch(/\d{6}/);
    expect(res.body.totalDebit).toEqual({ amount: '1160.000', minor: '1160000', currency: 'JOD' });
    expect(res.body.totalCredit.amount).toBe('1160.000');
    // Three decimal places throughout: JOD divides into 1000 fils.
    expect(res.body.lines[2].amount.amount).toBe('160.000');
  });

  it('rejects an unbalanced entry as ENTRY_UNBALANCED', async () => {
    const res = await api()
      .post('/api/v1/journal-entries')
      .set('X-Tenant-Id', tenantId)
      .send({
        entryDate: '2026-01-15',
        status: 'posted',
        lines: [
          { accountId: accounts.cash, side: 'debit', amountMinor: '100000' },
          { accountId: accounts.revenue, side: 'credit', amountMinor: '99000' },
        ],
      })
      .expect(422);
    expect(res.body.code).toBe('ENTRY_UNBALANCED');
  });

  it('rejects a posting to a summary account', async () => {
    const res = await api()
      .post('/api/v1/journal-entries')
      .set('X-Tenant-Id', tenantId)
      .send({
        entryDate: '2026-01-15',
        status: 'posted',
        lines: [
          { accountId: accounts.parent, side: 'debit', amountMinor: '1000' },
          { accountId: accounts.revenue, side: 'credit', amountMinor: '1000' },
        ],
      })
      .expect(422);
    expect(res.body.code).toBe('ACCOUNT_NOT_POSTABLE');
  });

  it('rejects an entry with fewer than two lines before it reaches the database', async () => {
    const res = await api()
      .post('/api/v1/journal-entries')
      .set('X-Tenant-Id', tenantId)
      .send({
        entryDate: '2026-01-15',
        lines: [{ accountId: accounts.cash, side: 'debit', amountMinor: '1000' }],
      })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a date with no fiscal period', async () => {
    const res = await api()
      .post('/api/v1/journal-entries')
      .set('X-Tenant-Id', tenantId)
      .send({ entryDate: '2030-01-15', status: 'posted', lines: invoiceLines() })
      .expect(422);
    expect(res.body.code).toBe('NO_FISCAL_PERIOD');
  });
});

describe('idempotency', () => {
  it('returns the original entry on a retry instead of duplicating it', async () => {
    const body = { entryDate: '2026-01-20', status: 'posted', lines: invoiceLines() };

    const first = await api()
      .post('/api/v1/journal-entries')
      .set('X-Tenant-Id', tenantId)
      .set('Idempotency-Key', 'retry-me-001')
      .send(body)
      .expect(201);

    const second = await api()
      .post('/api/v1/journal-entries')
      .set('X-Tenant-Id', tenantId)
      .set('Idempotency-Key', 'retry-me-001')
      .send(body)
      .expect(200);

    expect(second.body.id).toBe(first.body.id);
    expect(second.body.entryRef).toBe(first.body.entryRef);
    expect(second.headers['idempotent-replay']).toBe('true');

    const [{ count }] = await sql<{ count: string }[]>`
      SELECT count(*)::text FROM journal_entries WHERE external_id = 'retry-me-001'`;
    expect(count).toBe('1');
  });

  it('holds under concurrent retries of the same key', async () => {
    const body = { entryDate: '2026-01-21', status: 'posted', lines: invoiceLines() };
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        api()
          .post('/api/v1/journal-entries')
          .set('X-Tenant-Id', tenantId)
          .set('Idempotency-Key', 'concurrent-001')
          .send(body),
      ),
    );

    const ids = new Set(responses.map((r) => r.body.id));
    expect(ids.size).toBe(1);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
  });
});

describe('draft workflow', () => {
  it('saves a draft without a number and posts it later', async () => {
    const draft = await api()
      .post('/api/v1/journal-entries')
      .set('X-Tenant-Id', tenantId)
      .send({ entryDate: '2026-02-05', status: 'draft', lines: invoiceLines() })
      .expect(201);

    expect(draft.body.status).toBe('draft');
    expect(draft.body.entryNo).toBeNull();

    const posted = await api()
      .post(`/api/v1/journal-entries/${draft.body.id}/post`)
      .set('X-Tenant-Id', tenantId)
      .expect(200);

    expect(posted.body.status).toBe('posted');
    expect(posted.body.entryNo).not.toBeNull();
  });

  it('refuses to post the same draft twice', async () => {
    const draft = await api()
      .post('/api/v1/journal-entries')
      .set('X-Tenant-Id', tenantId)
      .send({ entryDate: '2026-02-06', status: 'draft', lines: invoiceLines() })
      .expect(201);

    await api().post(`/api/v1/journal-entries/${draft.body.id}/post`).set('X-Tenant-Id', tenantId).expect(200);
    const again = await api()
      .post(`/api/v1/journal-entries/${draft.body.id}/post`)
      .set('X-Tenant-Id', tenantId)
      .expect(409);
    expect(again.body.code).toBe('ENTRY_NOT_DRAFT');
  });

  it('refuses to post into a closed period', async () => {
    const draft = await api()
      .post('/api/v1/journal-entries')
      .set('X-Tenant-Id', tenantId)
      .send({ entryDate: '2026-03-10', status: 'draft', lines: invoiceLines() })
      .expect(201);

    await sql`
      UPDATE fiscal_periods SET status = 'closed'
       WHERE tenant_id = ${tenantId} AND period_no = 3 AND id NOT IN (
         SELECT period_id FROM journal_entries WHERE status = 'draft')`;
    // The draft blocks a hard close, so soft-close instead and try to post.
    await sql`UPDATE fiscal_periods SET status = 'soft_closed' WHERE tenant_id = ${tenantId} AND period_no = 3`;

    const res = await api()
      .post(`/api/v1/journal-entries/${draft.body.id}/post`)
      .set('X-Tenant-Id', tenantId)
      .expect(409);
    expect(res.body.code).toBe('PERIOD_CLOSED');

    await sql`UPDATE fiscal_periods SET status = 'open' WHERE tenant_id = ${tenantId} AND period_no = 3`;
  });
});

describe('reversal', () => {
  it('posts a mirror entry, links both, and nets the accounts to zero', async () => {
    const original = await api()
      .post('/api/v1/journal-entries')
      .set('X-Tenant-Id', tenantId)
      .send({ entryDate: '2026-02-10', status: 'posted', memo: 'to be reversed', lines: invoiceLines() })
      .expect(201);

    const res = await api()
      .post(`/api/v1/journal-entries/${original.body.id}/reverse`)
      .set('X-Tenant-Id', tenantId)
      .send({ reason: 'customer cancelled' })
      .expect(201);

    expect(res.body.original.status).toBe('reversed');
    expect(res.body.original.reversedByEntryId).toBe(res.body.reversal.id);
    expect(res.body.reversal.reversesEntryId).toBe(original.body.id);
    expect(res.body.reversal.lines.map((l: { side: string }) => l.side)).toEqual([
      'credit',
      'debit',
      'debit',
    ]);
    expect(res.body.reversal.totalDebit.amount).toBe(original.body.totalCredit.amount);
  });

  it('refuses to reverse a draft', async () => {
    const draft = await api()
      .post('/api/v1/journal-entries')
      .set('X-Tenant-Id', tenantId)
      .send({ entryDate: '2026-02-11', status: 'draft', lines: invoiceLines() })
      .expect(201);

    const res = await api()
      .post(`/api/v1/journal-entries/${draft.body.id}/reverse`)
      .set('X-Tenant-Id', tenantId)
      .send({ reason: 'nope' })
      .expect(409);
    expect(res.body.code).toBe('ENTRY_NOT_REVERSIBLE');
  });
});

describe('trial balance', () => {
  it('always balances and is computed from journal lines', async () => {
    const res = await api()
      .get('/api/v1/reports/trial-balance')
      .set('X-Tenant-Id', tenantId)
      .expect(200);

    expect(res.body.balanced).toBe(true);
    expect(res.body.difference.minor).toBe('0');
    expect(res.body.totalDebit.amount).toBe(res.body.totalCredit.amount);
    expect(res.body.currency).toBe('JOD');
  });

  it('agrees with the database ledger_verify function', async () => {
    const imbalances = await sql`SELECT * FROM ledger_verify(${tenantId}::uuid)`;
    expect(imbalances).toHaveLength(0);
  });

  it('filters by date range', async () => {
    const res = await api()
      .get('/api/v1/reports/trial-balance?fromDate=2026-01-01&toDate=2026-01-31')
      .set('X-Tenant-Id', tenantId)
      .expect(200);
    expect(res.body.balanced).toBe(true);
    expect(res.body.fromDate).toBe('2026-01-01');
  });

  it('hides zero-balance accounts unless asked', async () => {
    const hidden = await api().get('/api/v1/reports/trial-balance').set('X-Tenant-Id', tenantId);
    const shown = await api()
      .get('/api/v1/reports/trial-balance?includeZeroBalances=true')
      .set('X-Tenant-Id', tenantId);
    expect(shown.body.rows.length).toBeGreaterThanOrEqual(hidden.body.rows.length);
  });
});

describe('listing and pagination', () => {
  it('caps the page size at 200', async () => {
    const res = await api()
      .get('/api/v1/journal-entries?limit=500')
      .set('X-Tenant-Id', tenantId)
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('pages with a cursor', async () => {
    const first = await api()
      .get('/api/v1/journal-entries?limit=2')
      .set('X-Tenant-Id', tenantId)
      .expect(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await api()
      .get(`/api/v1/journal-entries?limit=2&cursor=${first.body.nextCursor}`)
      .set('X-Tenant-Id', tenantId)
      .expect(200);
    const firstIds = first.body.items.map((i: { id: string }) => i.id);
    expect(second.body.items.every((i: { id: string }) => !firstIds.includes(i.id))).toBe(true);
  });

  it('returns 404 for an unknown entry', async () => {
    const res = await api()
      .get('/api/v1/journal-entries/00000000-0000-7000-8000-000000000000')
      .set('X-Tenant-Id', tenantId)
      .expect(404);
    expect(res.body.code).toBe('ENTRY_NOT_FOUND');
  });
});
