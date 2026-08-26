# Architecture Decision Log

Format: decision, alternatives considered, rationale. Newest last.

## ADR-0001 — Money stored as BIGINT minor units with a per-currency exponent
**Decision.** Every monetary column is `BIGINT` holding minor units, paired with a currency code.
The exponent comes from `currencies.minor_unit_exponent`, not from a constant.
**Alternatives.** `NUMERIC(19,4)`; floats (never considered seriously); a fixed 2-decimal integer.
**Rationale.** JOD/KWD/BHD/TND have three decimal places and JPY has none. A hardcoded 2-decimal
assumption silently truncates fils on every Jordanian invoice, and the error compounds across a
tax period. Integers also make equality and summation exact, which is what the balance trigger needs.

## ADR-0002 — Invariants enforced in PostgreSQL, not only in application code
**Decision.** Balanced entries, immutability of posted entries, closed-period locks, append-only
audit log, and tenant isolation are all enforced by database constraints, triggers, and RLS.
**Alternatives.** Service-layer validation only; an event-sourced ledger.
**Rationale.** The database is the last line of defence and the only one shared by every writer —
API, background jobs, migrations, and a DBA with `psql`. Application-only checks are bypassed by
exactly the paths most likely to corrupt the books.

## ADR-0003 — Drizzle ORM with hand-reviewed SQL migrations, run as an explicit step
**Decision.** Schema changes are generated into `packages/db/migrations` and reviewed as SQL.
`packages/db/src/migrate.ts` applies them in a transaction, tracked in `schema_migrations`.
Migrations never run on API boot.
**Alternatives.** Prisma; TypeORM `synchronize`; Drizzle `push`.
**Rationale.** Triggers, deferrable constraints, and RLS policies are not expressible in a
portable ORM DSL and must be readable in review. Boot-time migration means a restart loop can
rewrite the schema of a live ledger.

## ADR-0004 — Environment validated with Zod at process start
**Decision.** `packages/shared/src/env.ts` is the single schema; the API parses it before binding
a port and throws with a per-field report on failure.
**Alternatives.** `@nestjs/config` defaults; reading `process.env` at point of use.
**Rationale.** A missing `DATABASE_URL` should be a boot failure, not a 500 discovered during a
month-end close. Sharing the schema keeps API and web from drifting.

## ADR-0005 — Liveness and readiness split
**Decision.** `/health` never touches dependencies; `/ready` checks Postgres and Redis and returns
503 with a machine-readable `code` when either is down.
**Alternatives.** A single `/health` that checks everything.
**Rationale.** A dependency blip should stop traffic being routed to the instance, not have the
orchestrator kill and restart a perfectly healthy process.
