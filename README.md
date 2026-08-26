# Accounting Platform

Self-hosted, multi-tenant, double-entry accounting. TypeScript end to end.
Ledger correctness outranks every other concern: the invariants in
`docs/DECISIONS.md` are enforced by PostgreSQL, not by application code alone.

## Quick start

```bash
git clone <repo> && cd accounting
cp .env.example .env
make dev
```

| Service | URL |
|---|---|
| Web | http://localhost:3000 |
| API | http://localhost:4000/api/v1 |
| API docs (OpenAPI) | http://localhost:4000/api/v1/docs |
| Liveness / readiness | http://localhost:4000/health, /ready |
| DB browser (pgweb) | http://localhost:8081 |
| Mail catcher (Mailhog) | http://localhost:8025 |
| MinIO console | http://localhost:9001 |

If port 3000 is already taken on your machine, set `WEB_PORT` in `.env`.

## Make targets

`dev` `down` `migrate` `migrate:new` `seed` `seed:demo` `test` `test:e2e` `lint`
`typecheck` `ledger:rebuild` `ledger:verify` `logs` `psql` `reset`

`reset` destroys the local data volumes.

## Layout

```
apps/api        NestJS 11 REST API, /api/v1, OpenAPI generated
apps/web        Next.js 15 App Router UI
packages/domain Framework-free accounting logic (money, posting rules, schedules)
packages/db     Drizzle schema, SQL migrations, migration runner, seeds
packages/shared Zod schemas shared by API and web (env, currency, DTOs)
```

## Migrations

```bash
make migrate:new   # generate SQL from the Drizzle schema
# review the generated file by hand, add triggers/policies as needed
make migrate       # apply pending migrations inside a transaction
```

Migrations never run automatically on boot.

## Ledger commands

```bash
make ledger:verify    # asserts debits = credits per tenant per currency; exits non-zero on drift
make ledger:rebuild   # recomputes account_balances from journal lines alone
```

Balances are always derived. If the cache and the journal ever disagree, the journal wins and
`ledger:verify` says so.

## Status

- **M0 — Foundation** complete: `docs/M0-foundation.md`
- **M1 — Ledger Core** complete: `docs/M1-ledger-core.md` (140 tests passing)

Next: M2 — auth, roles, RLS, audit log. Until then the tenant comes from an `X-Tenant-Id`
header and this build must not be exposed to a network.
