import type { Config } from 'drizzle-kit';

/**
 * Migrations are explicit SQL files, generated then reviewed by hand.
 * No push, no auto-sync: schema drift in a ledger is a restatement.
 */
export default {
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
} satisfies Config;
