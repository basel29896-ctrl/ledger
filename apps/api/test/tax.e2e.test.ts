import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import postgres from 'postgres';
import cookieParser from 'cookie-parser';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';

/** Tax: Jordan codes, the return, and JoFotara clearance against the mock. */

let container: StartedPostgreSqlContainer;
let app: INestApplication;
let owner: postgres.Sql;
let client: request.Agent;
let csrf = '';

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');
const PASSWORD = 'Correct-Horse-Battery-9';
const EMAIL = 'tax@test.local';

let tenantId: string;
let accounts: Record<'ar' | 'bank' | 'revenue' | 'outputTax' | 'inputTax' | 'expense', string>;
let taxCodes: Record<string, string> = {};
let customerId: string;
let vendorId: string;
let invoiceId = '';

function post(path: string): request.Test {
  return client.post(path).set('X-CSRF-Token', csrf);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('tax_test')
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
    INSERT INTO tenants (name, slug, base_currency) VALUES ('Tax Test','tax-test','JOD') RETURNING id`;
  tenantId = tenant!.id;
  await owner`
    INSERT INTO company_settings (tenant_id, legal_name, tax_number, address, base_currency,
                                  approval_threshold_minor)
    -- A one-person company: bills below this may be self-approved, which is
    -- what the segregation-of-duties threshold is for.
    VALUES (${tenantId}, 'Demo Company LLC', '1234567', 'Amman, Jordan', 'JOD', 100000000)`;

  const { AuthService } = await import('../src/auth/auth.service');
  const [user] = await owner<{ id: string }[]>`
    INSERT INTO users (tenant_id, email, display_name, password_hash)
    VALUES (${tenantId}, ${EMAIL}, 'Tax Tester', ${await AuthService.hashPassword(PASSWORD)})
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
    INSERT INTO accounts (tenant_id, code, name, type, subtype, normal_balance) VALUES
      (${tenantId},'1120','Bank','asset','bank','debit'),
      (${tenantId},'1130','Accounts Receivable','asset','receivable','debit'),
      (${tenantId},'1170','Input Tax Recoverable','asset','tax_receivable','debit'),
      (${tenantId},'2110','Accounts Payable','liability','payable','credit'),
      (${tenantId},'2130','Output Tax Payable','liability','tax_payable','credit'),
      (${tenantId},'4010','Sales Revenue','revenue','operating_revenue','credit'),
      (${tenantId},'5230','Utilities','expense','operating_expense','debit')
    RETURNING id, code`;
  const byCode = (code: string): string => rows.find((r) => r.code === code)!.id;
  accounts = {
    bank: byCode('1120'),
    ar: byCode('1130'),
    inputTax: byCode('1170'),
    outputTax: byCode('2130'),
    revenue: byCode('4010'),
    expense: byCode('5230'),
  };

  const { JORDAN_TAX_CODES } = await import('@acct/domain');
  for (const [index, code] of JORDAN_TAX_CODES.entries()) {
    const [saved] = await owner<{ id: string }[]>`
      INSERT INTO tax_codes (tenant_id, code, name, kind, rate_percent, treatment, is_withholding,
                             is_recoverable, output_account_id, input_account_id, sort_order)
      VALUES (${tenantId}, ${code.code}, ${code.name}, ${code.kind}::tax_kind,
              ${code.ratePercent.toString()}, ${code.treatment ?? 'standard'}::tax_treatment,
              ${code.isWithholding ?? false}, ${code.isRecoverable ?? true},
              ${accounts.outputTax}, ${accounts.inputTax}, ${index * 10})
      RETURNING id`;
    taxCodes[code.code] = saved!.id;
  }

  const [customer] = await owner<{ id: string }[]>`
    INSERT INTO contacts (tenant_id, code, name, is_customer, tax_number, billing_address)
    VALUES (${tenantId}, 'CUST-1', 'Petra Trading LLC', true, '7654321', 'Irbid') RETURNING id`;
  customerId = customer!.id;
  const [vendor] = await owner<{ id: string }[]>`
    INSERT INTO contacts (tenant_id, code, name, is_vendor, tax_number)
    VALUES (${tenantId}, 'VEND-1', 'Amman Supplies', true, '1112223') RETURNING id`;
  vendorId = vendor!.id;

  for (const [docType, prefix] of [
    ['journal_entry', 'JE-'],
    ['sales_invoice', 'INV-'],
    ['credit_note', 'CN-'],
    ['vendor_bill', 'BILL-'],
  ] as const) {
    await owner`
      INSERT INTO number_sequences (tenant_id, doc_type, scope_key, prefix, padding)
      VALUES (${tenantId}, ${docType}, ${docType === 'journal_entry' ? year!.id : ''}, ${prefix}, 5)`;
  }

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: `postgresql://acct_app_user:app-secret@${container.getHost()}:${container.getPort()}/tax_test`,
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
  // No JoFotara credentials: the mock provider is selected.
  delete process.env['JOFOTARA_CLIENT_ID'];
  delete process.env['JOFOTARA_SECRET_KEY'];

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
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await container?.stop();
});

describe('Jordan tax codes', () => {
  it('exposes the standard, reduced, telecom, zero-rated and exempt codes', async () => {
    const res = await client.get('/api/v1/tax-codes').expect(200);
    const codes = Object.fromEntries(
      res.body.map((c: { code: string; rate_percent: string; treatment: string }) => [
        c.code,
        c,
      ]),
    );
    expect(Number(codes['GST16'].rate_percent)).toBe(16);
    expect(Number(codes['GST24'].rate_percent)).toBe(24);
    expect(Number(codes['GST1'].rate_percent)).toBe(1);
    expect(codes['GST0'].treatment).toBe('zero_rated');
    expect(codes['EXEMPT'].treatment).toBe('exempt');
    expect(codes['WHT5'].is_withholding).toBe(true);
  });

  it('refuses a withholding code on the sales side', async () => {
    await expect(
      owner`
        INSERT INTO tax_codes (tenant_id, code, name, kind, rate_percent, is_withholding)
        VALUES (${tenantId}, 'BAD-WHT', 'Bad', 'sales', 5, true)`,
    ).rejects.toThrow(/tax_codes_withholding_is_purchase/);
  });

  it('accepts a compound Special Sales Tax configuration', async () => {
    const res = await post('/api/v1/tax-codes')
      .send({
        code: 'SST-TOBACCO',
        name: 'Special Sales Tax — tobacco',
        ratePercent: '20',
        outputAccountId: accounts.outputTax,
      })
      .expect(201);
    expect(res.body.id).toBeTruthy();

    const compound = await post('/api/v1/tax-codes')
      .send({
        code: 'GST16-SST',
        name: 'GST 16% on value plus excise',
        ratePercent: '16',
        compoundOn: ['SST-TOBACCO'],
        outputAccountId: accounts.outputTax,
      })
      .expect(201);
    expect(compound.body.id).toBeTruthy();
  });
});

describe('tax return', () => {
  beforeAll(async () => {
    // A standard-rated sale: 1000.000 net + 160.000 GST.
    const invoice = await post('/api/v1/sales-documents')
      .send({
        contactId: customerId,
        issueDate: '2026-01-15',
        post: true,
        lines: [
          {
            description: 'Consulting',
            quantity: '1',
            unitPriceMinor: '1000000',
            revenueAccountId: accounts.revenue,
            taxCodeId: taxCodes['GST16'],
          },
        ],
      })
      .expect(201);
    invoiceId = invoice.body.id;

    // A zero-rated export.
    await post('/api/v1/sales-documents')
      .send({
        contactId: customerId,
        issueDate: '2026-01-20',
        post: true,
        lines: [
          {
            description: 'Export sale',
            quantity: '1',
            unitPriceMinor: '500000',
            revenueAccountId: accounts.revenue,
            taxCodeId: taxCodes['GST0'],
          },
        ],
      })
      .expect(201);

    // A purchase with recoverable input tax: 400.000 + 64.000.
    const bill = await post('/api/v1/bills')
      .send({
        contactId: vendorId,
        issueDate: '2026-01-18',
        vendorInvoiceNo: 'V-1',
        lines: [
          {
            description: 'Electricity',
            quantity: '1',
            unitPriceMinor: '400000',
            expenseAccountId: accounts.expense,
            taxCodeId: taxCodes['GST16'],
          },
        ],
      })
      .expect(201);
    await post(`/api/v1/bills/${bill.body.id}/approve`).send({}).expect(200);
  });

  it('separates standard-rated, zero-rated and exempt sales', async () => {
    const res = await client
      .get('/api/v1/reports/tax-return?fromDate=2026-01-01&toDate=2026-01-31')
      .expect(200);
    expect(res.body.standardRatedSales.net.amount).toBe('1000.000');
    expect(res.body.zeroRatedSales.net.amount).toBe('500.000');
    expect(res.body.totalSales.net.amount).toBe('1500.000');
  });

  it('reports output tax, input tax and the net payable', async () => {
    const res = await client
      .get('/api/v1/reports/tax-return?fromDate=2026-01-01&toDate=2026-01-31')
      .expect(200);
    expect(res.body.outputTax.amount).toBe('160.000');
    expect(res.body.recoverableInputTax.amount).toBe('64.000');
    // 160.000 output − 64.000 recoverable input = 96.000 payable.
    expect(res.body.netPayable.amount).toBe('96.000');
    expect(res.body.position).toBe('payable');
  });

  it('breaks the figures down by tax code', async () => {
    const res = await client
      .get('/api/v1/reports/tax-return?fromDate=2026-01-01&toDate=2026-01-31')
      .expect(200);
    const codes = res.body.byCode.map((b: { code: string }) => b.code);
    expect(codes).toContain('GST16');
    expect(codes).toContain('GST0');
  });

  it('is empty for a period with no activity', async () => {
    const res = await client
      .get('/api/v1/reports/tax-return?fromDate=2026-06-01&toDate=2026-06-30')
      .expect(200);
    expect(res.body.netPayable.amount).toBe('0.000');
  });
});

describe('JoFotara clearance', () => {
  it('builds UBL 2.1 XML with the Jordan-required fields', async () => {
    const res = await client.get(`/api/v1/e-invoices/${invoiceId}/ubl`).expect(200);
    const xml = res.body.xml as string;
    expect(xml).toContain('urn:oasis:names:specification:ubl:schema:xsd:Invoice-2');
    // Supplier and buyer tax numbers, and JOD at three decimals.
    expect(xml).toContain('<cbc:CompanyID>1234567</cbc:CompanyID>');
    expect(xml).toContain('<cbc:CompanyID>7654321</cbc:CompanyID>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="JOD">1160.000</cbc:PayableAmount>');
  });

  it('lists the invoice in the clearance queue before submission', async () => {
    const res = await client.get('/api/v1/e-invoices/queue').expect(200);
    const entry = res.body.find((r: { id: string }) => r.id === invoiceId);
    expect(entry.clearance_status).toBe('not_submitted');
    expect(entry.clearance_attempts).toBe(0);
  });

  it('submits and stores the clearance UUID and QR code', async () => {
    const res = await post(`/api/v1/e-invoices/${invoiceId}/submit`).expect(200);
    expect(res.body.status).toBe('cleared');
    expect(res.body.clearanceUuid).toBe(`mock-${invoiceId}`);
    expect(res.body.qrCode).toBeTruthy();
    expect(res.body.isValidTaxDocument).toBe(true);

    const doc = await client.get(`/api/v1/sales-documents/${invoiceId}`).expect(200);
    expect(doc.body.clearance_status).toBe('cleared');
    expect(doc.body.clearance_qr).toBeTruthy();
    expect(doc.body.cleared_at).toBeTruthy();
  });

  it('drops the cleared invoice out of the queue', async () => {
    const res = await client.get('/api/v1/e-invoices/queue').expect(200);
    expect(res.body.find((r: { id: string }) => r.id === invoiceId)).toBeUndefined();
  });

  it('refuses to submit the same invoice twice', async () => {
    const res = await post(`/api/v1/e-invoices/${invoiceId}/submit`).expect(409);
    expect(res.body.code).toBe('ALREADY_CLEARED');
  });

  it('refuses to overwrite a clearance at the database level', async () => {
    await expect(
      owner`
        UPDATE sales_documents SET clearance_uuid = 'tampered' WHERE id = ${invoiceId}`,
    ).rejects.toThrow(/already cleared/);
  });

  it('refuses to submit a draft invoice', async () => {
    const draft = await post('/api/v1/sales-documents')
      .send({
        contactId: customerId,
        issueDate: '2026-02-01',
        post: false,
        lines: [
          {
            description: 'Draft work',
            quantity: '1',
            unitPriceMinor: '100000',
            revenueAccountId: accounts.revenue,
            taxCodeId: taxCodes['GST16'],
          },
        ],
      })
      .expect(201);

    const res = await post(`/api/v1/e-invoices/${draft.body.id}/submit`).expect(409);
    expect(res.body.code).toBe('DOCUMENT_NOT_POSTED');
  });

  it('shows an uncleared invoice as not a valid tax document', async () => {
    const queue = await client.get('/api/v1/e-invoices/queue').expect(200);
    // Everything still in the queue lacks a clearance UUID by definition.
    for (const row of queue.body) {
      expect(['not_submitted', 'pending', 'failed']).toContain(row.clearance_status);
    }
  });
});

describe('the ledger still balances', () => {
  it('reports no imbalance', async () => {
    const imbalances = await owner`SELECT * FROM ledger_verify(${tenantId}::uuid)`;
    expect(imbalances).toHaveLength(0);
  });
});
