import { z } from 'zod';

/**
 * Single source of truth for runtime configuration.
 * The app fails fast at boot when anything here is missing or malformed:
 * a mis-configured accounting system is worse than one that refuses to start.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // The API connects through a NON-superuser role so row-level security
  // actually applies; superusers bypass RLS entirely.
  DATABASE_URL: z.string().url(),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().positive().default(10),
  // Owner connection used only by migrations, seeds and cross-tenant maintenance.
  MIGRATION_DATABASE_URL: z.string().url().optional(),
  APP_DB_PASSWORD: z.string().min(8).optional(),

  REDIS_URL: z.string().url(),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  /* Optional. With no scanner an upload is marked `skipped`, never `clean`, so
   * "not scanned" is never mistaken for "scanned and safe". */
  VIRUS_SCAN_URL: z.string().url().optional(),

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive(),

  // Base currency of the deployment; per-tenant base currency lives in company_settings.
  DEFAULT_BASE_CURRENCY: z.string().length(3).default('JOD'),

  // --- auth ---
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(604800),
  COOKIE_DOMAIN: z.string().default('localhost'),
  COOKIE_SECURE: z.coerce.boolean().default(false),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  TOTP_ISSUER: z.string().default('Accounting'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
