import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';

/**
 * Explicit migration runner. Runs as its own step (`make migrate`),
 * never on API boot: a container restart must not be able to alter the schema.
 */
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

async function main(): Promise<void> {
  // Migrations need the owner connection: they create roles, policies and
  // triggers that the restricted application role must not be able to alter.
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required to run migrations');
  const sql = postgres(url, { max: 1, onnotice: () => {} });

  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  const applied = new Set(
    (await sql<{ filename: string }[]>`SELECT filename FROM schema_migrations`).map((r) => r.filename),
  );

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (filename) VALUES (${file})`;
    });
    console.log(`applied ${file}`);
    count += 1;
  }
  console.log(count === 0 ? 'no pending migrations' : `${count} migration(s) applied`);
  await provisionAppRole(sql);
  await sql.end();
}

/**
 * Create or update the login role the API uses. It inherits `acct_app`, which
 * holds table privileges but is NOT a superuser and NOT the table owner, so
 * every row-level security policy applies to it.
 */
async function provisionAppRole(sql: postgres.Sql): Promise<void> {
  const password = process.env.APP_DB_PASSWORD;
  if (!password) {
    console.log('APP_DB_PASSWORD not set; skipping application role provisioning');
    return;
  }
  const roleExists = await sql`SELECT 1 FROM pg_roles WHERE rolname = 'acct_app_user'`;
  if (roleExists.length === 0) {
    await sql.unsafe(`CREATE ROLE acct_app_user LOGIN PASSWORD '${password.replaceAll("'", "''")}' IN ROLE acct_app`);
    console.log('created login role acct_app_user');
  } else {
    await sql.unsafe(`ALTER ROLE acct_app_user WITH LOGIN PASSWORD '${password.replaceAll("'", "''")}'`);
    await sql`GRANT acct_app TO acct_app_user`;
  }
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO acct_app`;
  await sql`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO acct_app`;
  await sql`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO acct_app`;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
