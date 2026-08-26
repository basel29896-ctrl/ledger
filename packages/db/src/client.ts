import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { loadEnv } from '@acct/shared';

export function createDbClient(url?: string) {
  const env = loadEnv();
  const sql = postgres(url ?? env.DATABASE_URL, {
    max: env.DATABASE_MAX_CONNECTIONS,
    // Money never round-trips through a JS float.
    types: { bigint: postgres.BigInt },
    onnotice: () => {},
  });
  return { sql, db: drizzle(sql) };
}
