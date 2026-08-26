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
 * Accounts Payable end to end: purchase order → goods receipt → bill →
 * three-way match → approval → payment, with segregation of duties enforced by
 * the database and re-checked by the service.
 */

let container: StartedPostgreSqlContainer;
let app: INestApplication;
let owner: postgres.Sql;

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');
const PASSWORD = 'Correct-Horse-Battery-9';

let tenantId: string;
let accounts: Record<'ap' | 'bank' | 'expense' | 'inputTax', string>;
let taxCodeId: string;
let vendorId: string;

/** A signed-in agent plus its CSRF token. */
interface Client {
  agent: request.Agent;
  csrf: string;
  userId: string;
}
let clerk: Client;
let approver: Client;

async function signIn(email: string): Promise<Client> {
  const agent = request.agent(app.getHttpServer());
  await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  const me = await agent.get('/api/v1/auth/me').expect(200);
  const cookies = (me.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const csrf = cookies.find((c) => c.startsWith('csrf_token='))?.split(';')[0]?.split('=')[1] ?? '';
  return { agent, csrf, userId: me.body.id };
}

function post(client: Client, path: string): request.Test {
  return client.agent.post(path).set('X-CSRF-Token', client.csrf);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('ap_test')
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
    VALUES ('JOD','Jordanian Dinar','JD',3)`;
  const [tenant] = await owner<{ id: string }[]>`
    INSERT INTO tenants (name, slug, base_currency) VALUES ('AP Test','ap-test','JOD') RETURNING id`;
  tenantId = tenant!.id;

  // A 1,000.000 JOD approval threshold: anything above it needs a second pair of eyes.
  await owner`
    INSERT INTO company_settings (tenant_id, legal_name, base_currency, approval_threshold_minor)
    VALUES (${tenantId}, 'AP Test LLC', 'JOD', 1000000)`;

  const { AuthService } = await import('../src/auth/auth.service');
  const hash = await AuthService.hashPassword(PASSWORD);

  const [clerkRole] = await owner<{ id: string }[]>`
    INSERT INTO roles (tenant_id, code, name, is_system) VALUES (${tenantId},'clerk','Clerk',true) RETURNING id`;
  await owner`
    INSERT INTO role_permissions (role_id, permission_code)
    SELECT ${clerkRole!.id}, code FROM permissions
     WHERE code <> 'ap.bill.approve'`;
  const [approverRole] = await owner<{ id: string }[]>`
    INSERT INTO roles (tenant_id, code, name, is_system) VALUES (${tenantId},'approver','Approver',true) RETURNING id`;
  await owner`
    INSERT INTO role_permissions (role_id, permission_code) SELECT ${approverRole!.id}, code FROM permissions`;

  for (const [email, roleId] of [
    ['clerk@ap.local', clerkRole!.id],
    ['approver@ap.local', approverRole!.id],
  ] as const) {
    const [user] = await owner<{ id: string }[]>`
      INSERT INTO users (tenant_id, email, display_name, password_hash)
      VALUES (${tenantId}, ${email}, ${email}, ${hash}) RETURNING id`;
    await owner`INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES (${user!.id}, ${roleId}, ${tenantId})`;
  }

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
    INSERT INTO accounts (tenant_id, code, name, type, subtype, normal_balance, is_bank) VALUES
      (${tenantId},'1120','Bank','asset','bank','debit',true),
      (${tenantId},'1170','Input Tax Recoverable','asset','tax_receivable','debit',false),
      (${tenantId},'2110','Accounts Payable','liability','payable','credit',false),
      (${tenantId},'5230','Utilities','expense','operating_expense','debit',false)
    RETURNING id, code`;
  const byCode = (code: string): string => rows.find((r) => r.code === code)!.id;
  accounts = {
    bank: byCode('1120'),
    inputTax: byCode('1170'),
    ap: byCode('2110'),
    expense: byCode('5230'),
  };

  const [tax] = await owner<{ id: string }[]>`
    INSERT INTO tax_codes (tenant_id, code, name, kind, rate_percent, input_account_id)
    VALUES (${tenantId},'GST16','GST 16%','purchase',16,${accounts.inputTax}) RETURNING id`;
  taxCodeId = tax!.id;

  for (const [docType, prefix] of [
    ['purchase_order', 'PO-'],
    ['goods_receipt', 'GRN-'],
    ['vendor_bill', 'BILL-'],
    ['debit_note', 'DN-'],
    ['vendor_payment', 'PAY-'],
  ] as const) {
    await owner`
      INSERT INTO number_sequences (tenant_id, doc_type, scope_key, prefix, padding)
      VALUES (${tenantId}, ${docType}, '', ${prefix}, 5)`;
  }

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: `postgresql://acct_app_user:app-secret@${container.getHost()}:${container.getPort()}/ap_test`,
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

  clerk = await signIn('clerk@ap.local');
  approver = await signIn('approver@ap.local');

  const vendor = await post(clerk, '/api/v1/vendors')
    .send({ code: 'VEND-001', name: 'Amman Supplies Co', taxNumber: '7654321', paymentTermsDays: 30 })
    .expect(201);
  vendorId = vendor.body.id;
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await container?.stop();
});

async function trialBalance(): Promise<Record<string, { debit: string; credit: string }>> {
  const res = await approver.agent
    .get('/api/v1/reports/trial-balance?includeZeroBalances=true')
    .expect(200);
  return Object.fromEntries(
    res.body.rows.map((r: { accountCode: string; debitTotal: { amount: string }; creditTotal: { amount: string } }) => [
      r.accountCode,
      { debit: r.debitTotal.amount, credit: r.creditTotal.amount },
    ]),
  );
}

/** Raise a PO for `quantity` units at `unitPriceMinor` each. */
async function raiseOrder(quantity: string, unitPriceMinor: string): Promise<{ id: string; lineId: string }> {
  const res = await post(clerk, '/api/v1/purchase-orders')
    .send({
      contactId: vendorId,
      orderDate: '2026-01-05',
      lines: [
        {
          description: 'Office electricity',
          quantity,
          unitPriceMinor,
          expenseAccountId: accounts.expense,
          taxCodeId,
        },
      ],
    })
    .expect(201);
  return { id: res.body.id, lineId: res.body.lines[0].order_line_id };
}

describe('purchase orders', () => {
  it('raises an order and reports nothing received or billed yet', async () => {
    const order = await raiseOrder('10', '100000');
    const res = await clerk.agent.get(`/api/v1/purchase-orders/${order.id}`).expect(200);
    expect(res.body.po_ref).toMatch(/PO-/);
    expect(res.body.total_minor).toBe('1160000');
    expect(res.body.lines[0].quantity_ordered).toBe('10.0000');
    expect(res.body.lines[0].quantity_received).toBe('0');
    expect(res.body.lines[0].quantity_billed).toBe('0');
  });

  it('does not touch the ledger — an order is a commitment, not a transaction', async () => {
    // No postings exist yet, so payables and the expense account are absent
    // from the trial balance entirely rather than sitting at zero.
    const tb = await trialBalance();
    expect(tb['2110']?.credit ?? '0.000').toBe('0.000');
    expect(tb['5230']?.debit ?? '0.000').toBe('0.000');

    const [{ count }] = await owner<{ count: string }[]>`
      SELECT count(*)::text FROM journal_entries WHERE tenant_id = ${tenantId}`;
    expect(count).toBe('0');
  });
});

describe('three-way match', () => {
  it('matches when ordered, received and billed all agree', async () => {
    const order = await raiseOrder('10', '100000');
    await post(clerk, '/api/v1/goods-receipts')
      .send({
        orderId: order.id,
        receivedDate: '2026-01-10',
        lines: [{ orderLineId: order.lineId, quantityReceived: '10' }],
      })
      .expect(201);

    const bill = await post(clerk, '/api/v1/bills')
      .send({
        contactId: vendorId,
        issueDate: '2026-01-15',
        vendorInvoiceNo: 'V-1001',
        orderId: order.id,
        lines: [
          {
            description: 'Office electricity',
            quantity: '10',
            unitPriceMinor: '100000',
            expenseAccountId: accounts.expense,
            taxCodeId,
            orderLineId: order.lineId,
          },
        ],
      })
      .expect(201);

    expect(bill.body.match_status).toBe('matched');
    expect(bill.body.status).toBe('pending_approval');
  });

  it('raises an exception when the bill exceeds what was received', async () => {
    const order = await raiseOrder('10', '100000');
    await post(clerk, '/api/v1/goods-receipts')
      .send({
        orderId: order.id,
        receivedDate: '2026-01-10',
        lines: [{ orderLineId: order.lineId, quantityReceived: '6' }],
      })
      .expect(201);

    const bill = await post(clerk, '/api/v1/bills')
      .send({
        contactId: vendorId,
        issueDate: '2026-01-16',
        vendorInvoiceNo: 'V-1002',
        orderId: order.id,
        lines: [
          {
            description: 'Office electricity',
            quantity: '10',
            unitPriceMinor: '100000',
            expenseAccountId: accounts.expense,
            orderLineId: order.lineId,
          },
        ],
      })
      .expect(201);

    expect(bill.body.match_status).toBe('exception');
    expect(bill.body.match_notes).toContain('billed 10 against 6 received');
  });

  it('raises an exception when the supplier changed the price', async () => {
    const order = await raiseOrder('5', '100000');
    await post(clerk, '/api/v1/goods-receipts')
      .send({
        orderId: order.id,
        receivedDate: '2026-01-10',
        lines: [{ orderLineId: order.lineId, quantityReceived: '5' }],
      })
      .expect(201);

    const bill = await post(clerk, '/api/v1/bills')
      .send({
        contactId: vendorId,
        issueDate: '2026-01-17',
        vendorInvoiceNo: 'V-1003',
        orderId: order.id,
        lines: [
          {
            description: 'Office electricity',
            quantity: '5',
            unitPriceMinor: '120000',
            expenseAccountId: accounts.expense,
            orderLineId: order.lineId,
          },
        ],
      })
      .expect(201);

    expect(bill.body.match_status).toBe('exception');
    expect(bill.body.match_notes).toContain('120000');
  });

  it('lists the exceptions in a queue', async () => {
    const res = await clerk.agent.get('/api/v1/bills/match-exceptions').expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    expect(res.body[0].match_notes).toBeTruthy();
  });

  it('does not require a match on a bill with no purchase order', async () => {
    const bill = await post(clerk, '/api/v1/bills')
      .send({
        contactId: vendorId,
        issueDate: '2026-01-18',
        vendorInvoiceNo: 'V-1004',
        lines: [
          {
            description: 'Ad-hoc courier',
            quantity: '1',
            unitPriceMinor: '25000',
            expenseAccountId: accounts.expense,
          },
        ],
      })
      .expect(201);
    expect(bill.body.match_status).toBe('not_required');
  });
});

describe('approval and segregation of duties', () => {
  let bigBillId: string;

  beforeAll(async () => {
    const order = await raiseOrder('20', '100000');
    await post(clerk, '/api/v1/goods-receipts')
      .send({
        orderId: order.id,
        receivedDate: '2026-02-01',
        lines: [{ orderLineId: order.lineId, quantityReceived: '20' }],
      })
      .expect(201);
    const bill = await post(clerk, '/api/v1/bills')
      .send({
        contactId: vendorId,
        issueDate: '2026-02-02',
        vendorInvoiceNo: 'V-2001',
        orderId: order.id,
        lines: [
          {
            description: 'Office electricity',
            quantity: '20',
            unitPriceMinor: '100000',
            expenseAccountId: accounts.expense,
            taxCodeId,
            orderLineId: order.lineId,
          },
        ],
      })
      .expect(201);
    bigBillId = bill.body.id;
  });

  it('refuses approval from someone without the permission', async () => {
    const res = await post(clerk, `/api/v1/bills/${bigBillId}/approve`).send({}).expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('refuses the entering clerk as approver above the threshold', async () => {
    // Grant the clerk approval rights temporarily; the segregation rule must
    // still stop them approving their own 2,320.000 JOD bill.
    await owner`
      INSERT INTO role_permissions (role_id, permission_code)
      SELECT id, 'ap.bill.approve' FROM roles WHERE tenant_id = ${tenantId} AND code = 'clerk'`;
    const selfApprover = await signIn('clerk@ap.local');

    const res = await post(selfApprover, `/api/v1/bills/${bigBillId}/approve`).send({}).expect(409);
    expect(res.body.code).toBe('SEGREGATION_OF_DUTIES');

    await owner`
      DELETE FROM role_permissions
       WHERE permission_code = 'ap.bill.approve'
         AND role_id = (SELECT id FROM roles WHERE tenant_id = ${tenantId} AND code = 'clerk')`;
  });

  it('is refused at the database level too, not only in the service', async () => {
    const [clerkUser] = await owner<{ id: string }[]>`
      SELECT id FROM users WHERE tenant_id = ${tenantId} AND email = 'clerk@ap.local'`;
    await expect(
      owner`
        INSERT INTO bill_approvals (tenant_id, document_id, approver_id, decision)
        VALUES (${tenantId}, ${bigBillId}, ${clerkUser!.id}, 'approved')`,
    ).rejects.toThrow(/Segregation of duties/);
  });

  it('lets a different approver approve, and posts the bill', async () => {
    const before = await trialBalance();
    const res = await post(approver, `/api/v1/bills/${bigBillId}/approve`)
      .send({ reason: 'Checked against the meter reading' })
      .expect(200);

    expect(res.body.status).toBe('open');
    expect(res.body.doc_ref).toMatch(/BILL-/);
    expect(res.body.approvals).toHaveLength(1);

    const after = await trialBalance();
    // 2000.000 net + 320.000 tax = 2320.000 payable.
    const payableDelta = Number(after['2110']?.credit ?? 0) - Number(before['2110']?.credit ?? 0);
    const expenseDelta = Number(after['5230']?.debit ?? 0) - Number(before['5230']?.debit ?? 0);
    const taxDelta = Number(after['1170']?.debit ?? 0) - Number(before['1170']?.debit ?? 0);
    expect(payableDelta).toBeCloseTo(2320, 3);
    expect(expenseDelta).toBeCloseTo(2000, 3);
    expect(taxDelta).toBeCloseTo(320, 3);
  });

  it('will not approve the same bill twice', async () => {
    const res = await post(approver, `/api/v1/bills/${bigBillId}/approve`).send({}).expect(409);
    expect(res.body.code).toBe('BILL_NOT_PENDING');
  });

  it('refuses approval while a match exception is unresolved', async () => {
    const list = await clerk.agent.get('/api/v1/bills/match-exceptions').expect(200);
    const exceptionBill = list.body[0];
    const res = await post(approver, `/api/v1/bills/${exceptionBill.id}/approve`).send({}).expect(409);
    expect(res.body.code).toBe('MATCH_EXCEPTION_UNRESOLVED');
  });

  it('allows approval once the exception is overridden with a reason', async () => {
    const list = await clerk.agent.get('/api/v1/bills/match-exceptions').expect(200);
    const exceptionBill = list.body[0];

    const overridden = await post(approver, `/api/v1/bills/${exceptionBill.id}/override-match`)
      .send({ reason: 'Short delivery agreed with the supplier' })
      .expect(200);
    expect(overridden.body.match_status).toBe('overridden');

    const approved = await post(approver, `/api/v1/bills/${exceptionBill.id}/approve`)
      .send({})
      .expect(200);
    expect(approved.body.status).toBe('open');
  });

  it('rejects a bill back to the clerk', async () => {
    const bill = await post(clerk, '/api/v1/bills')
      .send({
        contactId: vendorId,
        issueDate: '2026-02-05',
        vendorInvoiceNo: 'V-2002',
        lines: [
          {
            description: 'Questionable charge',
            quantity: '1',
            unitPriceMinor: '50000',
            expenseAccountId: accounts.expense,
          },
        ],
      })
      .expect(201);

    const res = await post(approver, `/api/v1/bills/${bill.body.id}/reject`)
      .send({ reason: 'No supporting documentation' })
      .expect(200);
    expect(res.body.status).toBe('draft');
    expect(res.body.approvals.at(-1).decision).toBe('rejected');
  });
});

describe('duplicate protection', () => {
  it('refuses a second bill with the same vendor invoice number', async () => {
    await expect(
      owner`
        INSERT INTO purchase_documents (tenant_id, contact_id, vendor_invoice_no, issue_date,
                                        due_date, currency_code, status)
        VALUES (${tenantId}, ${vendorId}, 'V-2001', '2026-03-01', '2026-03-31', 'JOD', 'draft')`,
    ).rejects.toThrow(/purchase_documents_vendor_invoice_unique/);
  });

  it('allows the same number from a different vendor', async () => {
    const [other] = await owner<{ id: string }[]>`
      INSERT INTO contacts (tenant_id, code, name, is_vendor)
      VALUES (${tenantId}, 'VEND-002', 'Other Supplier', true) RETURNING id`;
    const rows = await owner`
      INSERT INTO purchase_documents (tenant_id, contact_id, vendor_invoice_no, issue_date,
                                      due_date, currency_code, status)
      VALUES (${tenantId}, ${other!.id}, 'V-2001', '2026-03-01', '2026-03-31', 'JOD', 'draft')
      RETURNING id`;
    expect(rows).toHaveLength(1);
  });
});

describe('vendor payments', () => {
  it('pays the oldest bill first and posts to the ledger', async () => {
    const before = await trialBalance();
    await post(approver, '/api/v1/vendor-payments')
      .set('Idempotency-Key', 'pay-001')
      .send({
        contactId: vendorId,
        paymentDate: '2026-03-01',
        amountMinor: '500000',
        bankAccountId: accounts.bank,
      })
      .expect(201);

    const after = await trialBalance();
    const payableDebit = Number(after['2110']?.debit ?? 0) - Number(before['2110']?.debit ?? 0);
    const bankCredit = Number(after['1120']?.credit ?? 0) - Number(before['1120']?.credit ?? 0);
    expect(payableDebit).toBeCloseTo(500, 3);
    expect(bankCredit).toBeCloseTo(500, 3);
  });

  it('returns the original payment when the key is retried', async () => {
    const res = await post(approver, '/api/v1/vendor-payments')
      .set('Idempotency-Key', 'pay-001')
      .send({
        contactId: vendorId,
        paymentDate: '2026-03-01',
        amountMinor: '500000',
        bankAccountId: accounts.bank,
      })
      .expect(200);
    expect(res.headers['idempotent-replay']).toBe('true');
  });

  it('refuses to pay a bill that is still awaiting approval', async () => {
    const bill = await post(clerk, '/api/v1/bills')
      .send({
        contactId: vendorId,
        issueDate: '2026-03-02',
        vendorInvoiceNo: 'V-3001',
        lines: [
          {
            description: 'Not yet approved',
            quantity: '1',
            unitPriceMinor: '10000',
            expenseAccountId: accounts.expense,
          },
        ],
      })
      .expect(201);

    const res = await post(approver, '/api/v1/vendor-payments')
      .send({
        contactId: vendorId,
        paymentDate: '2026-03-03',
        amountMinor: '10000',
        bankAccountId: accounts.bank,
        allocations: [{ documentId: bill.body.id, amountMinor: '10000' }],
      })
      .expect(422);
    expect(res.body.code).toBe('ALLOCATION_INVALID');
  });

  it('builds a payment run grouped by vendor', async () => {
    const res = await approver.agent.get('/api/v1/vendor-payments/run?dueBy=2026-12-31').expect(200);
    expect(res.body.vendors.length).toBeGreaterThan(0);
    const vendor = res.body.vendors[0];
    expect(vendor.documents.length).toBeGreaterThan(0);
    const summed = res.body.vendors.reduce(
      (total: number, v: { total: { minor: string } }) => total + Number(v.total.minor),
      0,
    );
    expect(summed).toBe(Number(res.body.total.minor));
  });
});

describe('AP reports', () => {
  it('ages outstanding bills', async () => {
    const res = await approver.agent.get('/api/v1/reports/ap-aging?asOf=2026-06-30').expect(200);
    expect(res.body.currency).toBe('JOD');
    const summed = Object.values(res.body.buckets).reduce(
      (total: number, bucket) => total + Number((bucket as { minor: string }).minor),
      0,
    );
    expect(summed).toBe(Number(res.body.total.minor));
  });

  it('forecasts cash requirements by horizon', async () => {
    const res = await approver.agent
      .get('/api/v1/reports/cash-requirements?asOf=2026-03-01')
      .expect(200);
    expect(res.body.buckets[0].label).toBe('Overdue and due today');
    expect(res.body.buckets.length).toBeGreaterThan(5);
  });
});

describe('the ledger still balances', () => {
  it('reports no imbalance', async () => {
    const imbalances = await owner`SELECT * FROM ledger_verify(${tenantId}::uuid)`;
    expect(imbalances).toHaveLength(0);
  });

  it('ties the AP control account to the sub-ledger', async () => {
    const tb = await trialBalance();
    const control =
      Number(tb['2110']?.credit ?? 0) * 1000 - Number(tb['2110']?.debit ?? 0) * 1000;

    const [subLedger] = await owner<{ total: string }[]>`
      SELECT COALESCE(SUM(outstanding_minor), 0)::text AS total
        FROM purchase_document_balances
       WHERE tenant_id = ${tenantId} AND status IN ('open', 'paid')`;
    const [unapplied] = await owner<{ total: string }[]>`
      SELECT COALESCE(SUM(unapplied_minor), 0)::text AS total
        FROM vendor_payment_balances WHERE tenant_id = ${tenantId}`;

    expect(Math.round(control)).toBe(Number(subLedger!.total) - Number(unapplied!.total));
  });
});
