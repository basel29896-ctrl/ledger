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
 * Attachment guards. These are the checks that run *before* a byte reaches
 * object storage, which is exactly why they can be tested without it.
 */

let container: StartedPostgreSqlContainer;
let app: INestApplication;
let owner: postgres.Sql;
let client: request.Agent;
let csrf = '';

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');
const PASSWORD = 'Correct-Horse-Battery-9';
const EMAIL = 'files@test.local';

let tenantId: string;
let entityId: string;

function post(path: string): request.Test {
  return client.post(path).set('X-CSRF-Token', csrf);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('files_test')
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
    INSERT INTO tenants (name, slug, base_currency) VALUES ('Files Test','files-test','JOD') RETURNING id`;
  tenantId = tenant!.id;
  entityId = tenantId; // any uuid will do: the guards run before the lookup
  await owner`
    INSERT INTO company_settings (tenant_id, legal_name, tax_number, address, base_currency)
    VALUES (${tenantId}, 'Demo Company LLC', '1234567', 'Amman, Jordan', 'JOD')`;

  const { AuthService } = await import('../src/auth/auth.service');
  const [user] = await owner<{ id: string }[]>`
    INSERT INTO users (tenant_id, email, display_name, password_hash)
    VALUES (${tenantId}, ${EMAIL}, 'Filer', ${await AuthService.hashPassword(PASSWORD)})
    RETURNING id`;
  const [role] = await owner<{ id: string }[]>`
    INSERT INTO roles (tenant_id, code, name, is_system) VALUES (${tenantId},'all','All',true) RETURNING id`;
  await owner`INSERT INTO role_permissions (role_id, permission_code) SELECT ${role!.id}, code FROM permissions`;
  await owner`INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES (${user!.id}, ${role!.id}, ${tenantId})`;

  await owner.unsafe(`CREATE ROLE acct_app_user LOGIN PASSWORD 'app-secret' IN ROLE acct_app`);
  await owner`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO acct_app`;
  await owner`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO acct_app`;
  await owner`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO acct_app`;

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: `postgresql://acct_app_user:app-secret@${container.getHost()}:${container.getPort()}/files_test`,
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
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await container?.stop();
});

function upload(body: Record<string, unknown>): request.Test {
  return post('/api/v1/attachments').send({ entityType: 'sales_document', entityId, ...body });
}

describe('upload guards', () => {
  it('refuses a type that is not on the allowlist', async () => {
    const res = await upload({
      fileName: 'payload.exe',
      contentType: 'application/x-msdownload',
      contentBase64: Buffer.from('MZ').toString('base64'),
    });
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  it('refuses a file whose bytes do not match the type it claims', async () => {
    const res = await upload({
      fileName: 'not-really.pdf',
      contentType: 'application/pdf',
      contentBase64: Buffer.from('this is plain text, not a PDF').toString('base64'),
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FILE_CONTENT_MISMATCH');
  });

  it('refuses an empty file', async () => {
    const res = await upload({ fileName: 'empty.csv', contentType: 'text/csv', contentBase64: '' });
    // Zod rejects the empty string before the service sees it.
    expect(res.status).toBe(400);
  });

  it('refuses a file over the size cap', async () => {
    const big = Buffer.alloc(21 * 1024 * 1024, 0x41);
    big.set([0x25, 0x50, 0x44, 0x46], 0); // a very large "PDF"
    const res = await upload({
      fileName: 'huge.pdf',
      contentType: 'application/pdf',
      contentBase64: big.toString('base64'),
    });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
  }, 60_000);
});

describe('reading', () => {
  it('reports an unknown attachment rather than signing a URL for nothing', async () => {
    const res = await client.get(`/api/v1/attachments/${tenantId}/url`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ATTACHMENT_NOT_FOUND');
  });

  it('lists nothing for a document with no attachments', async () => {
    const res = await client
      .get(`/api/v1/attachments?entityType=sales_document&entityId=${entityId}`)
      .expect(200);
    expect(res.body).toEqual([]);
  });

  it('never serves a file the scanner flagged', async () => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO attachments (tenant_id, entity_type, entity_id, object_key, file_name,
                               content_type, size_bytes, scan_status)
      VALUES (${tenantId}, 'sales_document', ${entityId}, ${`${tenantId}/infected.pdf`},
              'infected.pdf', 'application/pdf', 100, 'infected')
      RETURNING id`;
    const res = await client.get(`/api/v1/attachments/${row!.id}/url`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ATTACHMENT_INFECTED');
  });
});
