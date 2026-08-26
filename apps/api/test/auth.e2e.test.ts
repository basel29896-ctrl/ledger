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
 * Authentication, permissions and tenant scoping through the real API,
 * against a real database with row-level security switched on.
 */

let container: StartedPostgreSqlContainer;
let app: INestApplication;
let owner: postgres.Sql;

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');
const PASSWORD = 'Correct-Horse-Battery-9';

interface Fixture {
  tenantId: string;
  adminEmail: string;
  clerkEmail: string;
  viewerEmail: string;
  cashId: string;
  revenueId: string;
}
let fx: Fixture;
let otherTenant: { tenantId: string; email: string; cashId: string };

async function hash(password: string): Promise<string> {
  const { AuthService } = await import('../src/auth/auth.service');
  return AuthService.hashPassword(password);
}

async function seedTenant(slug: string, roles: Record<string, string[]>): Promise<{
  tenantId: string;
  cashId: string;
  revenueId: string;
}> {
  const [tenant] = await owner<{ id: string }[]>`
    INSERT INTO tenants (name, slug, base_currency) VALUES (${slug}, ${slug}, 'JOD') RETURNING id`;
  const tenantId = tenant!.id;

  const [year] = await owner<{ id: string }[]>`
    INSERT INTO fiscal_years (tenant_id, name, start_date, end_date)
    VALUES (${tenantId}, '2026', '2026-01-01', '2026-12-31') RETURNING id`;
  await owner`
    INSERT INTO fiscal_periods (tenant_id, fiscal_year_id, period_no, start_date, end_date)
    VALUES (${tenantId}, ${year!.id}, 1, '2026-01-01', '2026-01-31'),
           (${tenantId}, ${year!.id}, 2, '2026-02-01', '2026-02-28')`;

  const accounts = await owner<{ id: string; code: string }[]>`
    INSERT INTO accounts (tenant_id, code, name, type, normal_balance) VALUES
      (${tenantId}, '1110', 'Cash', 'asset', 'debit'),
      (${tenantId}, '4010', 'Sales Revenue', 'revenue', 'credit')
    RETURNING id, code`;

  // Roles with their permission grants.
  const roleIds: Record<string, string> = {};
  for (const [code, perms] of Object.entries(roles)) {
    const [role] = await owner<{ id: string }[]>`
      INSERT INTO roles (tenant_id, code, name, is_system) VALUES (${tenantId}, ${code}, ${code}, true)
      RETURNING id`;
    roleIds[code] = role!.id;
    for (const perm of perms) {
      await owner`INSERT INTO role_permissions (role_id, permission_code) VALUES (${role!.id}, ${perm})`;
    }
  }

  const passwordHash = await hash(PASSWORD);
  for (const code of Object.keys(roles)) {
    const [user] = await owner<{ id: string }[]>`
      INSERT INTO users (tenant_id, email, display_name, password_hash)
      VALUES (${tenantId}, ${`${code}@${slug}.local`}, ${code}, ${passwordHash}) RETURNING id`;
    await owner`
      INSERT INTO user_roles (user_id, role_id, tenant_id)
      VALUES (${user!.id}, ${roleIds[code]}, ${tenantId})`;
  }

  return {
    tenantId,
    cashId: accounts.find((a) => a.code === '1110')!.id,
    revenueId: accounts.find((a) => a.code === '4010')!.id,
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('auth_test')
    .withUsername('owner')
    .withPassword('owner')
    .start();

  owner = postgres(container.getConnectionUri(), { max: 4, onnotice: () => {} });
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  for (const file of files) await owner.unsafe(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));
  await owner`INSERT INTO currencies (code, name, symbol, minor_unit_exponent) VALUES ('JOD','Jordanian Dinar','JD',3)`;

  await owner.unsafe(`CREATE ROLE acct_app_user LOGIN PASSWORD 'app-secret' IN ROLE acct_app`);
  await owner`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO acct_app`;
  await owner`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO acct_app`;
  await owner`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO acct_app`;

  const main = await seedTenant('main', {
    admin: [
      'ledger.account.read', 'ledger.account.write', 'ledger.entry.read', 'ledger.entry.draft',
      'ledger.entry.post', 'ledger.entry.reverse', 'report.read', 'admin.user.read',
      'admin.user.write', 'admin.audit.read',
    ],
    clerk: ['ledger.account.read', 'ledger.entry.read', 'ledger.entry.draft'],
    viewer: ['report.read'],
  });
  fx = {
    tenantId: main.tenantId,
    adminEmail: 'admin@main.local',
    clerkEmail: 'clerk@main.local',
    viewerEmail: 'viewer@main.local',
    cashId: main.cashId,
    revenueId: main.revenueId,
  };

  const other = await seedTenant('rival', {
    admin: ['ledger.account.read', 'ledger.entry.read', 'ledger.entry.draft', 'ledger.entry.post', 'report.read'],
  });
  otherTenant = { tenantId: other.tenantId, email: 'admin@rival.local', cashId: other.cashId };

  const appUrl = `postgresql://acct_app_user:app-secret@${container.getHost()}:${container.getPort()}/auth_test`;
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: appUrl,
    MIGRATION_DATABASE_URL: container.getConnectionUri(),
    REDIS_URL: 'redis://localhost:6379',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_BUCKET: 'test',
    S3_ACCESS_KEY: 'test',
    S3_SECRET_KEY: 'test',
    SMTP_HOST: 'localhost',
    SMTP_PORT: '1025',
    JWT_ACCESS_SECRET: 'test-access-secret-that-is-long-enough-32',
    JWT_REFRESH_SECRET: 'test-refresh-secret-that-is-long-enough-32',
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

const api = (): request.Agent => request(app.getHttpServer());

/** Sign in and return an agent that keeps the session cookies. */
async function signIn(email: string, password = PASSWORD): Promise<request.Agent> {
  const agent = request.agent(app.getHttpServer());
  await agent.post('/api/v1/auth/login').send({ email, password }).expect(200);
  return agent;
}

describe('login', () => {
  it('signs in and sets httpOnly cookies', async () => {
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: fx.adminEmail, password: PASSWORD })
      .expect(200);

    expect(res.body.user.email).toBe(fx.adminEmail);
    expect(res.body.user.tenantId).toBe(fx.tenantId);
    expect(res.body.user.permissions).toContain('ledger.entry.post');
    // The tokens must never appear in the response body.
    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();

    const cookies = res.headers['set-cookie'] as unknown as string[];
    const access = cookies.find((c) => c.startsWith('access_token='));
    const refresh = cookies.find((c) => c.startsWith('refresh_token='));
    expect(access).toContain('HttpOnly');
    expect(access).toContain('SameSite=Strict');
    expect(refresh).toContain('HttpOnly');
    expect(refresh).toContain('Path=/api/v1/auth');
  });

  it('rejects a wrong password', async () => {
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: fx.adminEmail, password: 'wrong-password' })
      .expect(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('gives an unknown email the same answer as a wrong password', async () => {
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@main.local', password: PASSWORD })
      .expect(401);
    // Identical code and title: the endpoint must not confirm which emails exist.
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
    expect(res.body.title).toBe('Email or password is incorrect');
  });

  it('locks the account after repeated failures', async () => {
    const [user] = await owner<{ id: string }[]>`
      INSERT INTO users (tenant_id, email, display_name, password_hash)
      VALUES (${fx.tenantId}, 'lockme@main.local', 'Lock', ${await hash(PASSWORD)}) RETURNING id`;
    expect(user).toBeTruthy();

    for (let i = 0; i < 5; i += 1) {
      await api().post('/api/v1/auth/login').send({ email: 'lockme@main.local', password: 'nope' }).expect(401);
    }
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: 'lockme@main.local', password: PASSWORD })
      .expect(429);
    expect(res.body.code).toBe('ACCOUNT_LOCKED');
  });
});

describe('authentication is required', () => {
  it('refuses an unauthenticated request', async () => {
    const res = await api().get('/api/v1/accounts').expect(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a forged token', async () => {
    const res = await api()
      .get('/api/v1/accounts')
      .set('Authorization', 'Bearer not.a.real.token')
      .expect(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  it('leaves /health and /ready public', async () => {
    await api().get('/health').expect(200);
  });

  it('reports the caller identity at /auth/me', async () => {
    const agent = await signIn(fx.adminEmail);
    const res = await agent.get('/api/v1/auth/me').expect(200);
    expect(res.body.email).toBe(fx.adminEmail);
    expect(res.body.tenantId).toBe(fx.tenantId);
  });
});

describe('permissions', () => {
  it('lets a clerk save a draft', async () => {
    const agent = await signIn(fx.clerkEmail);
    const csrf = await csrfToken(agent);
    await agent
      .post('/api/v1/journal-entries')
      .set('X-CSRF-Token', csrf)
      .send({
        entryDate: '2026-01-15',
        status: 'draft',
        lines: [
          { accountId: fx.cashId, side: 'debit', amountMinor: '1000' },
          { accountId: fx.revenueId, side: 'credit', amountMinor: '1000' },
        ],
      })
      .expect(201);
  });

  it('stops a clerk posting that draft', async () => {
    const agent = await signIn(fx.clerkEmail);
    const csrf = await csrfToken(agent);
    const res = await agent
      .post('/api/v1/journal-entries')
      .set('X-CSRF-Token', csrf)
      .send({
        entryDate: '2026-01-15',
        status: 'posted',
        lines: [
          { accountId: fx.cashId, side: 'debit', amountMinor: '1000' },
          { accountId: fx.revenueId, side: 'credit', amountMinor: '1000' },
        ],
      })
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(res.body.title).toContain('ledger.entry.post');
  });

  it('stops a viewer reading the chart of accounts', async () => {
    const agent = await signIn(fx.viewerEmail);
    const res = await agent.get('/api/v1/accounts').expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('lets a viewer read a report', async () => {
    const agent = await signIn(fx.viewerEmail);
    await agent.get('/api/v1/reports/trial-balance').expect(200);
  });

  it('stops a clerk reading the audit log', async () => {
    const agent = await signIn(fx.clerkEmail);
    await agent.get('/api/v1/admin/audit-log').expect(403);
  });
});

describe('tenant scoping comes from the token, not the client', () => {
  it('ignores an X-Tenant-Id header entirely', async () => {
    const agent = await signIn(fx.adminEmail);
    const res = await agent
      .get('/api/v1/accounts')
      .set('X-Tenant-Id', otherTenant.tenantId)
      .expect(200);
    const ids = res.body.map((a: { id: string }) => a.id);
    expect(ids).toContain(fx.cashId);
    expect(ids).not.toContain(otherTenant.cashId);
  });

  it('cannot fetch another tenant journal entry by id', async () => {
    const rivalAgent = await signIn(otherTenant.email);
    const csrf = await csrfToken(rivalAgent);
    const created = await rivalAgent
      .post('/api/v1/journal-entries')
      .set('X-CSRF-Token', csrf)
      .send({
        entryDate: '2026-01-15',
        status: 'posted',
        lines: [
          { accountId: otherTenant.cashId, side: 'debit', amountMinor: '5000' },
          { accountId: otherTenant.cashId, side: 'credit', amountMinor: '5000' },
        ],
      })
      .expect(201);

    const agent = await signIn(fx.adminEmail);
    const res = await agent.get(`/api/v1/journal-entries/${created.body.id}`).expect(404);
    expect(res.body.code).toBe('ENTRY_NOT_FOUND');
  });
});

describe('CSRF protection', () => {
  it('refuses a cookie-authenticated mutation with no CSRF token', async () => {
    const agent = await signIn(fx.adminEmail);
    await agent.get('/api/v1/accounts');
    const res = await agent
      .post('/api/v1/accounts')
      .send({ code: '9100', name: 'No token', type: 'asset' })
      .expect(403);
    expect(res.body.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('accepts the mutation when the token is echoed back', async () => {
    const agent = await signIn(fx.adminEmail);
    const csrf = await csrfToken(agent);
    await agent
      .post('/api/v1/accounts')
      .set('X-CSRF-Token', csrf)
      .send({ code: '9101', name: 'With token', type: 'asset' })
      .expect(201);
  });

  it('exempts bearer-token clients, which do not use ambient credentials', async () => {
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: fx.adminEmail, password: PASSWORD })
      .expect(200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const token = cookies.find((c) => c.startsWith('access_token='))!.split(';')[0]!.split('=')[1]!;

    await api()
      .post('/api/v1/accounts')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '9102', name: 'Bearer', type: 'asset' })
      .expect(201);
  });
});

describe('refresh token rotation', () => {
  it('issues a new refresh token on each use', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/v1/auth/login').send({ email: fx.adminEmail, password: PASSWORD }).expect(200);
    // Refresh is a cookie-authenticated mutation, so it carries the CSRF token
    // like any other; the browser client does the same.
    const csrf = await csrfToken(agent);

    const first = await agent.post('/api/v1/auth/refresh').set('X-CSRF-Token', csrf).expect(200);
    expect(first.body.user.email).toBe(fx.adminEmail);
    const second = await agent.post('/api/v1/auth/refresh').set('X-CSRF-Token', csrf).expect(200);
    expect(second.body.user.email).toBe(fx.adminEmail);
  });

  it('refuses a refresh with no CSRF token', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/v1/auth/login').send({ email: fx.adminEmail, password: PASSWORD }).expect(200);
    await agent.get('/api/v1/auth/me').expect(200);
    const res = await agent.post('/api/v1/auth/refresh').expect(403);
    expect(res.body.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('revokes the whole family when a rotated token is replayed', async () => {
    const login = await api()
      .post('/api/v1/auth/login')
      .send({ email: fx.adminEmail, password: PASSWORD })
      .expect(200);
    const cookies = login.headers['set-cookie'] as unknown as string[];
    const stolen = cookies.find((c) => c.startsWith('refresh_token='))!.split(';')[0]!;

    // Legitimate use rotates it.
    await api().post('/api/v1/auth/refresh').set('Cookie', stolen).expect(200);
    // Replay of the same token is treated as theft.
    const replay = await api().post('/api/v1/auth/refresh').set('Cookie', stolen).expect(401);
    expect(replay.body.code).toBe('REFRESH_REUSED');
  });

  it('rejects an unknown refresh token', async () => {
    const res = await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', 'refresh_token=made-up-value')
      .expect(401);
    expect(res.body.code).toBe('REFRESH_INVALID');
  });

  it('clears cookies on logout', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/v1/auth/login').send({ email: fx.adminEmail, password: PASSWORD }).expect(200);
    const csrf = await csrfToken(agent);
    await agent.post('/api/v1/auth/logout').set('X-CSRF-Token', csrf).expect(204);
    await agent.get('/api/v1/auth/me').expect(401);
  });
});

describe('audit trail through the API', () => {
  it('records the acting user for a posting', async () => {
    const agent = await signIn(fx.adminEmail);
    const csrf = await csrfToken(agent);
    const created = await agent
      .post('/api/v1/journal-entries')
      .set('X-CSRF-Token', csrf)
      .send({
        entryDate: '2026-02-10',
        status: 'posted',
        memo: 'audited posting',
        lines: [
          { accountId: fx.cashId, side: 'debit', amountMinor: '2500' },
          { accountId: fx.revenueId, side: 'credit', amountMinor: '2500' },
        ],
      })
      .expect(201);

    const res = await agent
      .get(`/api/v1/admin/audit-log?entity=journal_entries&entityId=${created.body.id}`)
      .expect(200);

    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].action).toBe('INSERT');
    expect(res.body[0].actor_id).toBeTruthy();
  });
});

/** Read the CSRF cookie the guard hands out on a safe request. */
async function csrfToken(agent: request.Agent): Promise<string> {
  const res = await agent.get('/api/v1/auth/me');
  const cookies = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const cookie = cookies.find((c) => c.startsWith('csrf_token='));
  if (cookie) return cookie.split(';')[0]!.split('=')[1]!;
  // Already held from an earlier request in this agent session.
  const jar = (agent as unknown as { jar?: { getCookies: (url: string) => { key: string; value: string }[] } }).jar;
  const stored = jar?.getCookies('http://127.0.0.1')?.find((c) => c.key === 'csrf_token');
  return stored?.value ?? '';
}
