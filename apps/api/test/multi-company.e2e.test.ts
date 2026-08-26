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
 * Multi-company. One accountant with roles in two companies, and one with a
 * role in only one — the isolation that matters is that switching is checked
 * against the roles actually granted, and that data never crosses.
 */

let container: StartedPostgreSqlContainer;
let app: INestApplication;
let owner: postgres.Sql;

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');
const PASSWORD = 'Correct-Horse-Battery-9';

let alphaId = '';
let betaId = '';
let gammaId = '';

async function signIn(email: string): Promise<{ agent: request.Agent; csrf: string }> {
  const agent = request.agent(app.getHttpServer());
  await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  const me = await agent.get('/api/v1/auth/me').expect(200);
  const cookies = (me.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const csrf = cookies.find((c) => c.startsWith('csrf_token='))?.split(';')[0]?.split('=')[1] ?? '';
  return { agent, csrf };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('multi_test')
    .withUsername('owner')
    .withPassword('owner')
    .start();

  owner = postgres(container.getConnectionUri(), { max: 5, onnotice: () => {} });
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  for (const file of files) await owner.unsafe(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));

  await owner`INSERT INTO currencies (code, name, symbol, minor_unit_exponent) VALUES ('JOD','Jordanian Dinar','JD',3)`;

  const { AuthService } = await import('../src/auth/auth.service');
  const hash = await AuthService.hashPassword(PASSWORD);

  const makeTenant = async (name: string, slug: string): Promise<string> => {
    const [tenant] = await owner<{ id: string }[]>`
      INSERT INTO tenants (name, slug, base_currency) VALUES (${name}, ${slug}, 'JOD') RETURNING id`;
    await owner`
      INSERT INTO company_settings (tenant_id, legal_name, tax_number, address, base_currency)
      VALUES (${tenant!.id}, ${name}, '1234567', 'Amman', 'JOD')`;
    await owner`
      INSERT INTO accounts (tenant_id, code, name, type, subtype, normal_balance)
      VALUES (${tenant!.id}, '1120', ${`${name} Bank`}, 'asset', 'bank', 'debit')`;
    return tenant!.id;
  };

  alphaId = await makeTenant('Alpha Trading', 'alpha');
  betaId = await makeTenant('Beta Services', 'beta');
  gammaId = await makeTenant('Gamma Holdings', 'gamma');

  const roleFor = async (tenantId: string): Promise<string> => {
    const [role] = await owner<{ id: string }[]>`
      INSERT INTO roles (tenant_id, code, name, is_system) VALUES (${tenantId},'all','All',true)
      RETURNING id`;
    await owner`
      INSERT INTO role_permissions (role_id, permission_code) SELECT ${role!.id}, code FROM permissions`;
    return role!.id;
  };
  const alphaRole = await roleFor(alphaId);
  const betaRole = await roleFor(betaId);
  await roleFor(gammaId);

  // The group accountant: home in Alpha, also granted a role in Beta.
  const [group] = await owner<{ id: string }[]>`
    INSERT INTO users (tenant_id, email, display_name, password_hash)
    VALUES (${alphaId}, 'group@test.local', 'Group Accountant', ${hash}) RETURNING id`;
  await owner`
    INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES (${group!.id}, ${alphaRole}, ${alphaId})`;
  await owner`
    INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES (${group!.id}, ${betaRole}, ${betaId})`;

  // A bookkeeper who works for Beta only.
  const [local] = await owner<{ id: string }[]>`
    INSERT INTO users (tenant_id, email, display_name, password_hash)
    VALUES (${betaId}, 'beta@test.local', 'Beta Bookkeeper', ${hash}) RETURNING id`;
  await owner`
    INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES (${local!.id}, ${betaRole}, ${betaId})`;

  await owner.unsafe(`CREATE ROLE acct_app_user LOGIN PASSWORD 'app-secret' IN ROLE acct_app`);
  await owner`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO acct_app`;
  await owner`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO acct_app`;
  await owner`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO acct_app`;

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: `postgresql://acct_app_user:app-secret@${container.getHost()}:${container.getPort()}/multi_test`,
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
}, 300_000);

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await container?.stop();
});

describe('company list', () => {
  it('lists both companies for the group accountant, home first', async () => {
    const { agent } = await signIn('group@test.local');
    const res = await agent.get('/api/v1/auth/tenants').expect(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].isHome).toBe(true);
    expect(res.body.map((t: { slug: string }) => t.slug).sort()).toEqual(['alpha', 'beta']);
  });

  it('lists only the one company for the local bookkeeper', async () => {
    const { agent } = await signIn('beta@test.local');
    const res = await agent.get('/api/v1/auth/tenants').expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].slug).toBe('beta');
  });
});

describe('switching', () => {
  it('moves the session to the other company and shows its data', async () => {
    const { agent, csrf } = await signIn('group@test.local');

    const before = await agent.get('/api/v1/accounts').expect(200);
    expect(before.body[0].name).toBe('Alpha Trading Bank');

    const switched = await agent
      .post('/api/v1/auth/switch-tenant')
      .set('X-CSRF-Token', csrf)
      .send({ tenantId: betaId })
      .expect(200);
    expect(switched.body.user.tenantId).toBe(betaId);

    const after = await agent.get('/api/v1/accounts').expect(200);
    expect(after.body[0].name).toBe('Beta Services Bank');
  });

  it('refuses a company the user holds no role in', async () => {
    const { agent, csrf } = await signIn('group@test.local');
    const res = await agent
      .post('/api/v1/auth/switch-tenant')
      .set('X-CSRF-Token', csrf)
      .send({ tenantId: gammaId });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_A_MEMBER');
  });

  it('refuses the local bookkeeper a company they were never granted', async () => {
    const { agent, csrf } = await signIn('beta@test.local');
    const res = await agent
      .post('/api/v1/auth/switch-tenant')
      .set('X-CSRF-Token', csrf)
      .send({ tenantId: alphaId });
    expect(res.status).toBe(403);
  });

  it('keeps each company’s ledger to itself', async () => {
    const { agent } = await signIn('beta@test.local');
    const accounts = await agent.get('/api/v1/accounts').expect(200);
    expect(accounts.body).toHaveLength(1);
    expect(accounts.body[0].name).toBe('Beta Services Bank');
  });
});
