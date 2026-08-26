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

## ADR-0006 — Gapless numbering by row lock, not by SEQUENCE
**Decision.** `allocate_document_number()` takes `FOR UPDATE` on a `number_sequences` row,
returns the value and increments it inside the caller's transaction.
**Alternatives.** A Postgres `SEQUENCE`; allocating at draft creation; renumbering on a schedule.
**Rationale.** A sequence is non-transactional: a rolled-back posting burns its number and
leaves a hole. Tax authorities require an unbroken document series, so correctness beats the
concurrency cost. Numbers are allocated only at *posting* time, so an abandoned draft costs
nothing. Measured: 100 concurrent postings serialise cleanly and yield exactly 1..100.

## ADR-0007 — Balance enforcement as a deferred constraint trigger
**Decision.** The debit = credit check runs `AFTER INSERT OR UPDATE OR DELETE … DEFERRABLE
INITIALLY DEFERRED`, on both `journal_lines` and `journal_entries`.
**Alternatives.** An immediate trigger; a check in the service layer; a stored procedure as the
only write path.
**Rationale.** Header and lines must be insertable in any order within one transaction, so the
check can only run at COMMIT. Putting it on both tables closes the hole where a header is
posted with no lines at all. Because it is a constraint trigger it cannot be bypassed by any
writer, which a stored procedure could be (`INSERT` directly into the table).

## ADR-0008 — Posted entries are immutable except for the reversal link
**Decision.** The immutability trigger reconstructs `OLD` with only `status`,
`reversed_by_entry_id`, `reversal_reason` and `updated_at` overwritten, then requires
`NEW IS NOT DISTINCT FROM` that row. Any other change, and any DELETE, raises.
**Alternatives.** Revoking UPDATE at the role level; a whitelist of column names; allowing edits
before the period closes.
**Rationale.** A column whitelist has to be maintained as the table grows and silently permits
whatever is added next; comparing whole rows fails closed. Role-level revocation cannot express
"except this one transition". Allowing pre-close edits destroys the audit trail that the whole
system exists to produce.
**Note.** The trigger is named `journal_entries_01_immutable` on purpose — Postgres fires
BEFORE triggers in name order, and this one must speak first so a rejected tampering attempt
reports the real reason.

## ADR-0009 — The trial balance report reads journal lines, not the balance cache
**Decision.** `GET /reports/trial-balance` aggregates `journal_lines` directly.
`account_balances` exists for period-scoped and statement queries later in the roadmap.
**Alternatives.** Serve the report from the cache; maintain the cache incrementally on each post.
**Rationale.** If the cache is ever wrong, a report drawn from it looks right and hides the
problem. Reading from the source of truth means the report and `ledger:verify` can never
disagree. When the cache becomes a performance necessity, the rebuild command and its
byte-identical test are already in place to police it.

## ADR-0010 — Tenant resolved from a header in M1, with `SET LOCAL app.tenant_id` already in place
**Decision.** Every ledger transaction issues `SELECT set_config('app.tenant_id', …, true)`
even though no RLS policy reads it yet. M1 takes the tenant from an `X-Tenant-Id` header.
**Alternatives.** Waiting for M2 to introduce the session variable; filtering only in queries.
**Rationale.** Attaching RLS in M2 then becomes a migration that adds policies, with no change
to a single query — the plumbing is already correct. The header is an acknowledged stopgap and
is documented as such: this build must not be exposed to a network before M2.
