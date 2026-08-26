import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Row-level security and the audit trail.
 *
 * These tests connect as `acct_app_user` — a plain login role, not the owner
 * and not a superuser — because a superuser bypasses RLS entirely and would
 * make the policies look like they work when they do not.
 */

let container: StartedPostgreSqlContainer;
/** Owner connection: migrations, fixtures, cross-tenant setup. */
let owner: postgres.Sql;
/** Application connection: subject to every RLS policy. */
let app: postgres.Sql;

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

const tenants: Record<'a' | 'b', { id: string; accountId: string; userId: string; periodId: string; yearId: string }> =
  {
    a: { id: '', accountId: '', userId: '', periodId: '', yearId: '' },
    b: { id: '', accountId: '', userId: '', periodId: '', yearId: '' },
  };

async function seedTenant(slug: string): Promise<(typeof tenants)['a']> {
  const [tenant] = await owner<{ id: string }[]>`
    INSERT INTO tenants (name, slug, base_currency) VALUES (${slug}, ${slug}, 'JOD') RETURNING id`;
  const [user] = await owner<{ id: string }[]>`
    INSERT INTO users (tenant_id, email, display_name)
    VALUES (${tenant!.id}, ${`u@${slug}.local`}, ${slug}) RETURNING id`;
  const [year] = await owner<{ id: string }[]>`
    INSERT INTO fiscal_years (tenant_id, name, start_date, end_date)
    VALUES (${tenant!.id}, '2026', '2026-01-01', '2026-12-31') RETURNING id`;
  const [period] = await owner<{ id: string }[]>`
    INSERT INTO fiscal_periods (tenant_id, fiscal_year_id, period_no, start_date, end_date)
    VALUES (${tenant!.id}, ${year!.id}, 1, '2026-01-01', '2026-01-31') RETURNING id`;
  const [account] = await owner<{ id: string }[]>`
    INSERT INTO accounts (tenant_id, code, name, type, normal_balance)
    VALUES (${tenant!.id}, '1110', ${`Cash ${slug}`}, 'asset', 'debit') RETURNING id`;
  return {
    id: tenant!.id,
    userId: user!.id,
    yearId: year!.id,
    periodId: period!.id,
    accountId: account!.id,
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('rls_test')
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

  tenants.a = await seedTenant('alpha');
  tenants.b = await seedTenant('beta');

  app = postgres({
    host: container.getHost(),
    port: container.getPort(),
    database: 'rls_test',
    username: 'acct_app_user',
    password: 'app-secret',
    max: 4,
    onnotice: () => {},
  });
}, 240_000);

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await container?.stop();
});

/** Run work with the tenant pinned, exactly as the API does. */
async function asTenant<T>(
  tenantId: string,
  work: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return app.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return work(tx);
  }) as Promise<T>;
}

describe('the application role is not privileged enough to bypass RLS', () => {
  it('is neither superuser nor able to bypass row-level security', async () => {
    const [role] = await app<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(role?.rolsuper).toBe(false);
    expect(role?.rolbypassrls).toBe(false);
  });
});

describe('invariant 9 — row-level security blocks cross-tenant access', () => {
  it('sees only its own accounts', async () => {
    const rows = await asTenant(tenants.a.id, (tx) => tx<{ name: string }[]>`SELECT name FROM accounts`);
    expect(rows.map((r) => r.name)).toEqual(['Cash alpha']);
  });

  it('cannot read another tenant rows even when asked for them by id', async () => {
    const rows = await asTenant(
      tenants.a.id,
      (tx) => tx`SELECT id FROM accounts WHERE id = ${tenants.b.accountId}`,
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot update another tenant rows', async () => {
    await asTenant(
      tenants.a.id,
      (tx) => tx`UPDATE accounts SET name = 'hijacked' WHERE id = ${tenants.b.accountId}`,
    );
    const [row] = await owner<{ name: string }[]>`
      SELECT name FROM accounts WHERE id = ${tenants.b.accountId}`;
    expect(row?.name).toBe('Cash beta');
  });

  it('cannot delete another tenant rows', async () => {
    await asTenant(tenants.a.id, (tx) => tx`DELETE FROM accounts WHERE id = ${tenants.b.accountId}`);
    const rows = await owner`SELECT 1 FROM accounts WHERE id = ${tenants.b.accountId}`;
    expect(rows).toHaveLength(1);
  });

  it('cannot insert a row belonging to another tenant', async () => {
    await expect(
      asTenant(
        tenants.a.id,
        (tx) => tx`
          INSERT INTO accounts (tenant_id, code, name, type, normal_balance)
          VALUES (${tenants.b.id}, '9001', 'Smuggled', 'asset', 'debit')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('returns nothing at all when no tenant is set', async () => {
    const rows = await app<{ id: string }[]>`SELECT id FROM accounts`;
    expect(rows).toHaveLength(0);
  });

  it('isolates journal entries and lines the same way', async () => {
    await asTenant(tenants.a.id, async (tx) => {
      const [entry] = await tx<{ id: string }[]>`
        INSERT INTO journal_entries (tenant_id, entry_date, period_id, fiscal_year_id, status, base_currency)
        VALUES (${tenants.a.id}, '2026-01-15', ${tenants.a.periodId}, ${tenants.a.yearId}, 'draft', 'JOD')
        RETURNING id`;
      await tx`
        INSERT INTO journal_lines (tenant_id, entry_id, line_no, account_id, side, amount_minor, currency_code, base_amount_minor)
        VALUES (${tenants.a.id}, ${entry!.id}, 1, ${tenants.a.accountId}, 'debit', 1000, 'JOD', 1000),
               (${tenants.a.id}, ${entry!.id}, 2, ${tenants.a.accountId}, 'credit', 1000, 'JOD', 1000)`;
    });

    const fromB = await asTenant(tenants.b.id, (tx) => tx`SELECT id FROM journal_entries`);
    expect(fromB).toHaveLength(0);
    const fromA = await asTenant(tenants.a.id, (tx) => tx`SELECT id FROM journal_entries`);
    expect(fromA).toHaveLength(1);
  });
});

describe('invariant 8 — the audit trail', () => {
  it('records every insert with the acting user', async () => {
    const accountId = await asTenant(tenants.a.id, async (tx) => {
      await tx`SELECT set_config('app.user_id', ${tenants.a.userId}, true)`;
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO accounts (tenant_id, code, name, type, normal_balance)
        VALUES (${tenants.a.id}, '5220', 'Rent', 'expense', 'debit') RETURNING id`;
      return row!.id;
    });

    const [entry] = await asTenant(
      tenants.a.id,
      (tx) => tx<{ action: string; actor_id: string; after: Record<string, unknown> }[]>`
        SELECT action, actor_id, after FROM audit_log
         WHERE entity = 'accounts' AND entity_id = ${accountId}`,
    );
    expect(entry?.action).toBe('INSERT');
    expect(entry?.actor_id).toBe(tenants.a.userId);
    expect(entry?.after?.['code']).toBe('5220');
  });

  it('records the before and after images of an update', async () => {
    await asTenant(tenants.a.id, async (tx) => {
      await tx`UPDATE accounts SET name = 'Rent and rates' WHERE code = '5220'`;
    });
    const rows = await asTenant(
      tenants.a.id,
      (tx) => tx<{ before: Record<string, unknown>; after: Record<string, unknown> }[]>`
        SELECT before, after FROM audit_log
         WHERE entity = 'accounts' AND action = 'UPDATE' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]?.before?.['name']).toBe('Rent');
    expect(rows[0]?.after?.['name']).toBe('Rent and rates');
  });

  it('refuses UPDATE of the audit log', async () => {
    await expect(owner`UPDATE audit_log SET action = 'TAMPERED' WHERE id > 0`).rejects.toThrow(
      /append-only/,
    );
  });

  it('refuses DELETE of the audit log', async () => {
    await expect(owner`DELETE FROM audit_log WHERE id > 0`).rejects.toThrow(/append-only/);
  });

  it('refuses TRUNCATE of the audit log', async () => {
    await expect(owner`TRUNCATE audit_log`).rejects.toThrow(/append-only/);
  });

  it('is itself tenant-isolated', async () => {
    // Tenant B has audit rows of its own from its fixture inserts; what it must
    // never see is a row belonging to tenant A.
    const visible = await asTenant(
      tenants.b.id,
      (tx) => tx<{ tenant_id: string }[]>`SELECT DISTINCT tenant_id FROM audit_log`,
    );
    expect(visible.map((r) => r.tenant_id)).toEqual([tenants.b.id]);

    const aRows = await asTenant(
      tenants.b.id,
      (tx) => tx`SELECT id FROM audit_log WHERE tenant_id = ${tenants.a.id}`,
    );
    expect(aRows).toHaveLength(0);

    const aRowsForA = await asTenant(
      tenants.a.id,
      (tx) => tx`SELECT id FROM audit_log WHERE entity = 'accounts'`,
    );
    expect(aRowsForA.length).toBeGreaterThan(0);
  });
});

describe('the auditor database role is read-only', () => {
  it('cannot write even with a tenant set', async () => {
    await owner.unsafe(`CREATE ROLE acct_auditor_user LOGIN PASSWORD 'audit-secret' IN ROLE acct_auditor`);
    await owner`GRANT SELECT ON ALL TABLES IN SCHEMA public TO acct_auditor`;

    const auditor = postgres({
      host: container.getHost(),
      port: container.getPort(),
      database: 'rls_test',
      username: 'acct_auditor_user',
      password: 'audit-secret',
      max: 1,
      onnotice: () => {},
    });

    try {
      await expect(
        auditor.begin(async (tx) => {
          await tx`SELECT set_config('app.tenant_id', ${tenants.a.id}, true)`;
          await tx`
            INSERT INTO accounts (tenant_id, code, name, type, normal_balance)
            VALUES (${tenants.a.id}, '9999', 'Nope', 'asset', 'debit')`;
        }),
      ).rejects.toThrow(/permission denied/i);

      const rows = await auditor.begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${tenants.a.id}, true)`;
        return tx`SELECT code FROM accounts`;
      });
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      await auditor.end();
    }
  });
});
