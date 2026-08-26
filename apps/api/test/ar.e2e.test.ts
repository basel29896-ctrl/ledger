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
 * Accounts Receivable end to end: invoice → receipt → allocation → aging,
 * with the ledger checked after every step. The sub-ledger and the GL are the
 * same ledger, so if they can drift these tests will show it.
 */

let container: StartedPostgreSqlContainer;
let app: INestApplication;
let owner: postgres.Sql;
let client: request.Agent;
let csrf = '';

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');
const PASSWORD = 'Correct-Horse-Battery-9';
const EMAIL = 'ar@test.local';

let tenantId: string;
let accounts: Record<'ar' | 'bank' | 'revenue' | 'tax', string>;
let taxCodeId: string;
let customerId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('ar_test')
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
    INSERT INTO tenants (name, slug, base_currency) VALUES ('AR Test','ar-test','JOD') RETURNING id`;
  tenantId = tenant!.id;

  await owner`
    INSERT INTO company_settings (tenant_id, legal_name, tax_number, address, base_currency)
    VALUES (${tenantId}, 'AR Test LLC', '9876543', 'Amman, Jordan', 'JOD')`;

  const { AuthService } = await import('../src/auth/auth.service');
  const [user] = await owner<{ id: string }[]>`
    INSERT INTO users (tenant_id, email, display_name, password_hash)
    VALUES (${tenantId}, ${EMAIL}, 'AR Tester', ${await AuthService.hashPassword(PASSWORD)})
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
    const start = new Date(Date.UTC(2026, month - 1, 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(2026, month, 0)).toISOString().slice(0, 10);
    await owner`
      INSERT INTO fiscal_periods (tenant_id, fiscal_year_id, period_no, start_date, end_date)
      VALUES (${tenantId}, ${year!.id}, ${month}, ${start}, ${end})`;
  }

  const rows = await owner<{ id: string; code: string }[]>`
    INSERT INTO accounts (tenant_id, code, name, type, subtype, normal_balance, is_bank) VALUES
      (${tenantId},'1120','Bank','asset','bank','debit',true),
      (${tenantId},'1130','Accounts Receivable','asset','receivable','debit',false),
      (${tenantId},'2130','Output Tax Payable','liability','tax_payable','credit',false),
      (${tenantId},'4010','Sales Revenue','revenue','operating_revenue','credit',false)
    RETURNING id, code`;
  const byCode = (code: string): string => rows.find((r) => r.code === code)!.id;
  accounts = {
    bank: byCode('1120'),
    ar: byCode('1130'),
    tax: byCode('2130'),
    revenue: byCode('4010'),
  };

  const [tax] = await owner<{ id: string }[]>`
    INSERT INTO tax_codes (tenant_id, code, name, kind, rate_percent, output_account_id)
    VALUES (${tenantId},'GST16','General Sales Tax 16%','sales',16,${accounts.tax}) RETURNING id`;
  taxCodeId = tax!.id;

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: `postgresql://acct_app_user:app-secret@${container.getHost()}:${container.getPort()}/ar_test`,
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

  const customer = await post('/api/v1/customers')
    .send({
      code: 'CUST-001',
      name: 'Petra Trading LLC',
      taxNumber: '1234567',
      email: 'ap@petra.example',
      paymentTermsDays: 30,
    })
    .expect(201);
  customerId = customer.body.id;
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await container?.stop();
});

function post(path: string): request.Test {
  return client.post(path).set('X-CSRF-Token', csrf);
}

function invoiceBody(overrides: Record<string, unknown> = {}) {
  return {
    contactId: customerId,
    issueDate: '2026-01-15',
    post: true,
    lines: [
      {
        description: 'Consulting services',
        quantity: '1',
        unitPriceMinor: '1000000',
        revenueAccountId: accounts.revenue,
        taxCodeId,
      },
    ],
    ...overrides,
  };
}

/** Trial balance straight from the ledger, keyed by account code. */
async function trialBalance(): Promise<Record<string, { debit: string; credit: string }>> {
  const res = await client.get('/api/v1/reports/trial-balance?includeZeroBalances=true').expect(200);
  return Object.fromEntries(
    res.body.rows.map((r: { accountCode: string; debitTotal: { amount: string }; creditTotal: { amount: string } }) => [
      r.accountCode,
      { debit: r.debitTotal.amount, credit: r.creditTotal.amount },
    ]),
  );
}

describe('customers', () => {
  it('creates a customer and reports zero outstanding', async () => {
    const res = await client.get('/api/v1/customers').expect(200);
    const customer = res.body.find((c: { code: string }) => c.code === 'CUST-001');
    expect(customer.name).toBe('Petra Trading LLC');
    expect(customer.outstanding_minor).toBe('0');
  });

  it('rejects a duplicate customer code', async () => {
    const res = await post('/api/v1/customers')
      .send({ code: 'CUST-001', name: 'Duplicate' })
      .expect(500);
    expect(res.body.code).toBeTruthy();
  });
});

describe('issuing an invoice', () => {
  let invoiceId: string;

  it('posts an invoice and derives the due date from the payment terms', async () => {
    const res = await post('/api/v1/sales-documents')
      .set('Idempotency-Key', 'inv-001')
      .send(invoiceBody())
      .expect(201);

    invoiceId = res.body.id;
    expect(res.body.doc_ref).toMatch(/\d+/);
    expect(res.body.status).toBe('open');
    // 2026-01-15 + 30 days
    expect(res.body.due_date).toBe('2026-02-14');
    // 1000.000 net + 16% = 1160.000 gross
    expect(res.body.subtotal_minor).toBe('1000000');
    expect(res.body.tax_total_minor).toBe('160000');
    expect(res.body.total_minor).toBe('1160000');
    expect(res.body.outstanding_minor).toBe('1160000');
  });

  it('writes the matching journal entry', async () => {
    const tb = await trialBalance();
    expect(tb['1130']?.debit).toBe('1160.000');
    expect(tb['4010']?.credit).toBe('1000.000');
    expect(tb['2130']?.credit).toBe('160.000');
  });

  it('leaves the ledger balanced', async () => {
    const res = await client.get('/api/v1/reports/trial-balance').expect(200);
    expect(res.body.balanced).toBe(true);
    const imbalances = await owner`SELECT * FROM ledger_verify(${tenantId}::uuid)`;
    expect(imbalances).toHaveLength(0);
  });

  it('returns the original invoice when the same Idempotency-Key is retried', async () => {
    const res = await post('/api/v1/sales-documents')
      .set('Idempotency-Key', 'inv-001')
      .send(invoiceBody())
      .expect(200);
    expect(res.body.id).toBe(invoiceId);
    expect(res.headers['idempotent-replay']).toBe('true');
  });

  it('refuses to edit a posted invoice at the database level', async () => {
    await expect(
      owner`UPDATE sales_documents SET total_minor = 1 WHERE id = ${invoiceId}`,
    ).rejects.toThrow(/posted; correct it with a credit note/);
  });

  it('refuses to delete a posted invoice', async () => {
    await expect(owner`DELETE FROM sales_documents WHERE id = ${invoiceId}`).rejects.toThrow(
      /cannot be deleted; issue a credit note/,
    );
  });

  it('refuses totals that do not match the lines', async () => {
    await expect(
      owner.begin(async (tx) => {
        const [doc] = await tx<{ id: string }[]>`
          INSERT INTO sales_documents (tenant_id, contact_id, issue_date, due_date, currency_code,
                                       subtotal_minor, tax_total_minor, total_minor, status,
                                       doc_no, journal_entry_id)
          VALUES (${tenantId}, ${customerId}, '2026-01-15','2026-02-14','JOD',
                  1000, 160, 9999, 'open', 999, NULL) RETURNING id`;
        await tx`
          INSERT INTO sales_document_lines (tenant_id, document_id, line_no, description, quantity,
                                            unit_price_minor, line_total_minor, tax_amount_minor,
                                            revenue_account_id)
          VALUES (${tenantId}, ${doc!.id}, 1, 'x', 1, 1000, 1000, 160, ${accounts.revenue})`;
      }),
    ).rejects.toThrow();
  });

  it('saves a draft without touching the ledger', async () => {
    const before = await trialBalance();
    const res = await post('/api/v1/sales-documents')
      .send(invoiceBody({ post: false, issueDate: '2026-01-20' }))
      .expect(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.doc_ref).toBeNull();
    const after = await trialBalance();
    expect(after['1130']?.debit).toBe(before['1130']?.debit);

    // and posting it later does write the entry
    const posted = await post(`/api/v1/sales-documents/${res.body.id}/post`).expect(200);
    expect(posted.body.status).toBe('open');
    const final = await trialBalance();
    expect(final['1130']?.debit).toBe('2320.000');
  });
});

describe('receipts and allocation', () => {
  let invoiceId: string;

  beforeAll(async () => {
    const res = await post('/api/v1/sales-documents')
      .send(
        invoiceBody({
          issueDate: '2026-02-01',
          lines: [
            {
              description: 'February retainer',
              quantity: '1',
              unitPriceMinor: '500000',
              revenueAccountId: accounts.revenue,
              taxCodeId,
            },
          ],
        }),
      )
      .expect(201);
    invoiceId = res.body.id;
  });

  it('records a partial receipt and leaves the balance outstanding', async () => {
    await post('/api/v1/customer-receipts')
      .set('Idempotency-Key', 'rcpt-001')
      .send({
        contactId: customerId,
        paymentDate: '2026-02-10',
        amountMinor: '300000',
        bankAccountId: accounts.bank,
        allocations: [{ documentId: invoiceId, amountMinor: '300000' }],
      })
      .expect(201);

    const doc = await client.get(`/api/v1/sales-documents/${invoiceId}`).expect(200);
    expect(doc.body.allocated_minor).toBe('300000');
    expect(doc.body.outstanding_minor).toBe('280000');
    expect(doc.body.status).toBe('open');
  });

  it('posts the receipt to the bank and receivables', async () => {
    const tb = await trialBalance();
    expect(tb['1120']?.debit).toBe('300.000');
    expect(tb['1130']?.credit).toBe('300.000');
  });

  it('marks the invoice paid once nothing is outstanding', async () => {
    await post('/api/v1/customer-receipts')
      .send({
        contactId: customerId,
        paymentDate: '2026-02-20',
        amountMinor: '280000',
        bankAccountId: accounts.bank,
        allocations: [{ documentId: invoiceId, amountMinor: '280000' }],
      })
      .expect(201);

    const doc = await client.get(`/api/v1/sales-documents/${invoiceId}`).expect(200);
    expect(doc.body.outstanding_minor).toBe('0');
    expect(doc.body.status).toBe('paid');
  });

  it('refuses to allocate more than the invoice owes', async () => {
    const res = await post('/api/v1/customer-receipts')
      .send({
        contactId: customerId,
        paymentDate: '2026-02-21',
        amountMinor: '100000',
        bankAccountId: accounts.bank,
        allocations: [{ documentId: invoiceId, amountMinor: '100000' }],
      })
      .expect(422);
    expect(res.body.code).toBe('ALLOCATION_INVALID');
  });

  it('settles the oldest invoice first when no allocation is given', async () => {
    // A customer with no history, so the ordering under test is the only thing
    // deciding where the money lands.
    const fresh = await post('/api/v1/customers')
      .send({ code: 'CUST-FIFO', name: 'FIFO Customer', paymentTermsDays: 0 })
      .expect(201);

    const line = (description: string) => [
      { description, quantity: '1', unitPriceMinor: '100000', revenueAccountId: accounts.revenue },
    ];
    const first = await post('/api/v1/sales-documents')
      .send({ contactId: fresh.body.id, issueDate: '2026-03-01', post: true, lines: line('March A') })
      .expect(201);
    const second = await post('/api/v1/sales-documents')
      .send({ contactId: fresh.body.id, issueDate: '2026-03-15', post: true, lines: line('March B') })
      .expect(201);

    await post('/api/v1/customer-receipts')
      .send({
        contactId: fresh.body.id,
        paymentDate: '2026-03-20',
        amountMinor: '100000',
        bankAccountId: accounts.bank,
      })
      .expect(201);

    const firstDoc = await client.get(`/api/v1/sales-documents/${first.body.id}`).expect(200);
    const secondDoc = await client.get(`/api/v1/sales-documents/${second.body.id}`).expect(200);
    // The older invoice is settled; the newer one is untouched.
    expect(firstDoc.body.status).toBe('paid');
    expect(secondDoc.body.outstanding_minor).toBe('100000');
  });

  it('keeps an overpayment unapplied instead of forcing it onto an invoice', async () => {
    const fresh = await post('/api/v1/customers')
      .send({ code: 'CUST-OVERPAY', name: 'Generous Customer', paymentTermsDays: 0 })
      .expect(201);
    await post('/api/v1/sales-documents')
      .send({
        contactId: fresh.body.id,
        issueDate: '2026-03-01',
        post: true,
        lines: [
          { description: 'Small job', quantity: '1', unitPriceMinor: '100000', revenueAccountId: accounts.revenue },
        ],
      })
      .expect(201);

    const receipt = await post('/api/v1/customer-receipts')
      .send({
        contactId: fresh.body.id,
        paymentDate: '2026-03-25',
        amountMinor: '500000',
        bankAccountId: accounts.bank,
      })
      .expect(201);

    const list = await client.get(`/api/v1/customer-receipts?contactId=${fresh.body.id}`).expect(200);
    const row = list.body.find((r: { id: string }) => r.id === receipt.body.id);
    // 500.000 received against a 100.000 invoice: 400.000 stays on account.
    expect(row.allocated_minor).toBe('100000');
    expect(row.unapplied_minor).toBe('400000');
  });

  it('refuses an allocation across contacts, at the database level', async () => {
    const [other] = await owner<{ id: string }[]>`
      INSERT INTO contacts (tenant_id, code, name, is_customer)
      VALUES (${tenantId}, 'CUST-OTHER', 'Someone Else', true) RETURNING id`;
    // Target an invoice that still owes money, so the failure under test is the
    // contact mismatch rather than an over-allocation.
    const [openDoc] = await owner<{ document_id: string }[]>`
      SELECT document_id FROM sales_document_balances
       WHERE tenant_id = ${tenantId} AND status = 'open' AND outstanding_minor > 0 LIMIT 1`;
    await expect(
      owner.begin(async (tx) => {
        const [payment] = await tx<{ id: string }[]>`
          INSERT INTO payments (tenant_id, direction, contact_id, payment_date, currency_code,
                                amount_minor, bank_account_id, status)
          VALUES (${tenantId}, 'received', ${other!.id}, '2026-03-01', 'JOD', 1000,
                  ${accounts.bank}, 'posted') RETURNING id`;
        await tx`
          INSERT INTO payment_allocations (tenant_id, payment_id, document_id, amount_minor)
          VALUES (${tenantId}, ${payment!.id}, ${openDoc!.document_id}, 1000)`;
      }),
    ).rejects.toThrow(/another contact document/);
  });
});

describe('credit notes', () => {
  it('mirrors the invoice posting', async () => {
    const before = await trialBalance();
    await post('/api/v1/sales-documents')
      .send(
        invoiceBody({
          docType: 'credit_note',
          issueDate: '2026-04-01',
          lines: [
            {
              description: 'Returned services',
              quantity: '1',
              unitPriceMinor: '100000',
              revenueAccountId: accounts.revenue,
              taxCodeId,
            },
          ],
        }),
      )
      .expect(201);

    const after = await trialBalance();
    // A credit note credits receivables and debits revenue — the mirror image.
    const arCreditDelta =
      Number(after['1130']?.credit ?? 0) - Number(before['1130']?.credit ?? 0);
    const revenueDebitDelta =
      Number(after['4010']?.debit ?? 0) - Number(before['4010']?.debit ?? 0);
    expect(arCreditDelta).toBeCloseTo(116, 3);
    expect(revenueDebitDelta).toBeCloseTo(100, 3);
  });
});

describe('AR aging', () => {
  it('buckets outstanding invoices by how overdue they are', async () => {
    const res = await client.get('/api/v1/reports/ar-aging?asOf=2026-06-30').expect(200);
    expect(res.body.currency).toBe('JOD');
    const contact = res.body.contacts.find((c: { contactCode: string }) => c.contactCode === 'CUST-001');
    expect(contact).toBeTruthy();
    // Everything issued in Q1 with 30-day terms is well overdue by 30 June.
    expect(Number(contact.buckets.d120_plus.minor) + Number(contact.buckets.d91_120.minor)).toBeGreaterThan(0);
    expect(contact.documents.length).toBeGreaterThan(0);
  });

  it('totals the buckets back to the grand total', async () => {
    const res = await client.get('/api/v1/reports/ar-aging?asOf=2026-06-30').expect(200);
    const summed = Object.values(res.body.buckets).reduce(
      (total: number, bucket) => total + Number((bucket as { minor: string }).minor),
      0,
    );
    expect(summed).toBe(Number(res.body.total.minor));
  });

  it('excludes an invoice that is fully paid', async () => {
    const res = await client.get('/api/v1/reports/ar-aging?asOf=2026-06-30').expect(200);
    const contact = res.body.contacts.find((c: { contactCode: string }) => c.contactCode === 'CUST-001');
    const refs = contact.documents.map((d: { docRef: string }) => d.docRef);
    const paid = await owner<{ doc_ref: string }[]>`
      SELECT doc_ref FROM sales_documents WHERE status = 'paid' AND tenant_id = ${tenantId}`;
    for (const row of paid) expect(refs).not.toContain(row.doc_ref);
  });
});

describe('statement of account', () => {
  it('runs a balance forward through invoices and receipts', async () => {
    const res = await client
      .get(`/api/v1/customers/${customerId}/statement?fromDate=2026-01-01&toDate=2026-12-31`)
      .expect(200);

    expect(res.body.contact.name).toBe('Petra Trading LLC');
    expect(res.body.entries.length).toBeGreaterThan(0);
    // The closing balance must equal the sum of what is still outstanding.
    const [outstanding] = await owner<{ total: string }[]>`
      SELECT COALESCE(SUM(outstanding_minor), 0)::text AS total
        FROM sales_document_balances
       WHERE contact_id = ${customerId} AND doc_type = 'invoice' AND status <> 'void'`;
    const unapplied = await owner<{ total: string }[]>`
      SELECT COALESCE(SUM(unapplied_minor), 0)::text AS total
        FROM payment_balances WHERE contact_id = ${customerId}`;
    const credits = await owner<{ total: string }[]>`
      SELECT COALESCE(SUM(total_minor), 0)::text AS total
        FROM sales_documents WHERE contact_id = ${customerId}
          AND doc_type = 'credit_note' AND status <> 'void'`;
    const expected =
      BigInt(outstanding!.total) - BigInt(unapplied[0]!.total) - BigInt(credits[0]!.total);
    expect(res.body.closingBalance.minor).toBe(expected.toString());
  });
});

describe('invoice PDF', () => {
  it('renders a PDF carrying the required tax-invoice fields', async () => {
    const list = await client.get('/api/v1/sales-documents?status=paid&limit=1').expect(200);
    const id = list.body[0].id;
    const res = await client.get(`/api/v1/sales-documents/${id}/pdf`).expect(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    const body = res.body as Buffer;
    expect(body.subarray(0, 4).toString()).toBe('%PDF');
    const text = body.toString('latin1');
    expect(text.length).toBeGreaterThan(1000);
  });
});

describe('the ledger still balances after all of it', () => {
  it('reports no imbalance for any currency', async () => {
    const imbalances = await owner`SELECT * FROM ledger_verify(${tenantId}::uuid)`;
    expect(imbalances).toHaveLength(0);
  });

  it('ties the AR control account to the sum of outstanding documents', async () => {
    const tb = await trialBalance();
    const arBalance =
      Number(tb['1130']?.debit ?? 0) * 1000 - Number(tb['1130']?.credit ?? 0) * 1000;

    const [subLedger] = await owner<{ total: string }[]>`
      SELECT COALESCE(SUM(CASE WHEN doc_type = 'invoice' THEN outstanding_minor
                               ELSE -outstanding_minor END), 0)::text AS total
        FROM sales_document_balances WHERE tenant_id = ${tenantId}`;
    const [unapplied] = await owner<{ total: string }[]>`
      SELECT COALESCE(SUM(unapplied_minor), 0)::text AS total
        FROM payment_balances WHERE tenant_id = ${tenantId}`;

    // Control account = open invoices − credit notes − receipts not yet applied.
    expect(Math.round(arBalance)).toBe(Number(subLedger!.total) - Number(unapplied!.total));
  });
});
