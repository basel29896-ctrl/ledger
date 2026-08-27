# Accounting Platform

Self-hosted, multi-tenant, double-entry accounting. TypeScript end to end.
Ledger correctness outranks every other concern: the invariants in
`docs/DECISIONS.md` are enforced by PostgreSQL, not by application code alone.

## Live demo

**<https://basel29896-ctrl.github.io/ledger/>** — the application itself, running
entirely in your browser. No sign-in, nothing to install.

It is a static export whose API client answers requests locally. The trial
balance, general ledger and financial statements are computed live by the same
`@acct/domain` package the server uses, so posting an entry moves every report;
inventory costing, depreciation and budget variance are replayed from a dataset
captured through the real API, because those belong to a database transaction.
The demo says which is which on screen, and none of the database-level
invariants apply there — those need the server.

The written record is published alongside it at
[`/docs`](https://basel29896-ctrl.github.io/ledger/docs/).

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

All milestones are complete. Full suite: **550 tests passing** (domain 274,
einvoice-jo 16, db 56, api 204), plus a Playwright suite that runs against a
live stack.

| Milestone | Notes |
| --- | --- |
| M0 — Foundation | `docs/M0-foundation.md` |
| M1 — Ledger core | `docs/M1-ledger-core.md` — the ten invariants, enforced in the database |
| M2 — Auth, RBAC, RLS, audit | `docs/M2-auth-tenancy.md` |
| M3 — Manual GL screens | `docs/M3-manual-gl-ui.md` |
| M4 — Accounts receivable | `docs/M4-accounts-receivable.md` |
| M5 — Accounts payable | `docs/M5-accounts-payable.md` — three-way match, segregation of duties |
| M6 — Banking and reconciliation | `docs/M6-banking.md` |
| M7 — Tax, Jordan, JoFotara | `docs/M7-tax.md` |
| M8 — Financial statements | `docs/M8-financial-statements.md` |
| M9 — Period close | `docs/M9-period-close.md` |
| M10 — Inventory | `docs/M10-inventory.md` |
| M11 — Fixed assets | `docs/M11-fixed-assets.md` |
| M12 — Budget, multi-company, platform | `docs/M12-platform.md` |

Design decisions are recorded as ADRs in `docs/DECISIONS.md` (31 entries).

## Packages

```
packages/einvoice-jo   JoFotara adapter behind a provider interface (UBL 2.1, TLV QR)
```

## Security

```bash
pnpm scan:secrets       # staged files, before a credential can enter history
pnpm scan:secrets:all   # the whole tree
```

Gitleaks runs the deeper scan in CI. Secrets come from the environment only —
`JOFOTARA_CLIENT_ID` and `JOFOTARA_SECRET_KEY` included, which are never in the
repository.

**Encryption at rest is assumed to be provided by the volume or disk, not by the
application.** Postgres data, MinIO objects and backups must sit on encrypted
storage; the application encrypts nothing itself and does not pretend to.

## End-to-end tests

```bash
make dev        # a real stack, migrated and seeded
make test:e2e   # Playwright against it
```
