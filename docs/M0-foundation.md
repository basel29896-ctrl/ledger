# M0 — Foundation

## What was built
- **Monorepo.** pnpm workspaces + Turborepo. `apps/api`, `apps/web`, `packages/domain`,
  `packages/db`, `packages/shared`. TypeScript strict with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`, shared from `tsconfig.base.json`.
- **Docker Compose.** postgres:16-alpine (named volume, `pg_isready` healthcheck), redis:7-alpine,
  MinIO (console 9001), Mailhog (1025/8025), pgweb (8081), api (hot reload), web (Next dev server).
  `docker-compose.test.yml` runs an ephemeral tmpfs Postgres for CI.
- **Env validation.** `packages/shared/src/env.ts` — one Zod schema, parsed before the server binds.
  `.env.example` documents every variable.
- **Migration tooling.** Explicit runner in `packages/db/src/migrate.ts`, each file applied inside a
  transaction and recorded in `schema_migrations`. `0000_bootstrap.sql` enables `pgcrypto` and
  `uuid-ossp`; the Postgres init script does the same on a fresh volume.
- **API.** NestJS 11 with global prefix `/api/v1`, OpenAPI 3.1 at `/api/v1/docs`, Pino JSON logs with
  an `x-request-id` propagated in and out, and `/health` + `/ready`.
- **Web.** Next.js 15 App Router + React 19 + Tailwind 4 shell.
- **CI.** GitHub Actions: install, build, typecheck, lint, migrate, test, plus a gitleaks secret scan.
- **Makefile.** `dev down migrate migrate:new seed seed:demo test test:e2e lint typecheck
  ledger:rebuild ledger:verify logs psql reset`.

## Key decisions
See `docs/DECISIONS.md` ADR-0001 through ADR-0005.

## Verified
- `pnpm build`, `pnpm typecheck` green across all five packages.
- `docker compose up -d` brings up every service healthy.
- `pnpm --filter @acct/db migrate` → `applied 0000_bootstrap.sql`; re-run is a no-op.
- `GET /health` → `{"status":"ok",...}`; `GET /ready` → `{"status":"ready","checks":{"postgres":"up","redis":"up"}}`.

## Known gaps (deliberate, scheduled)
- No schema beyond extensions — the ledger tables and every invariant trigger are M1.
- `seed` is a stub; `ledger:rebuild` / `ledger:verify` Make targets exist but have no
  implementation behind them until M1.
- No auth, no RLS, no rate limiting — M2.
- Lint scripts are placeholders in the packages; a shared ESLint 9 flat config lands with M1
  when there is real code to lint.
- The `prod` Dockerfile stages are not yet size-optimised (they copy the full workspace);
  hardening pass is M12.
