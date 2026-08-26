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

## ADR-0011 — The API connects as a non-owner, non-superuser role
**Decision.** `DATABASE_URL` points at `acct_app_user` (member of `acct_app`).
`MIGRATION_DATABASE_URL` points at the owner and is used only by migrations, seeds and
cross-tenant maintenance.
**Alternatives.** One connection as the owner; disabling RLS in development.
**Rationale.** A superuser bypasses row-level security silently, and the table owner bypasses it
unless the table is marked `FORCE`. Either would leave the policies looking correct while doing
nothing. Splitting the roles means the isolation tests exercise the same path production does.

## ADR-0012 — Login goes through SECURITY DEFINER functions, not a relaxed policy
**Decision.** Thirteen narrow functions in `0003_auth_functions.sql` handle every read and write
that must happen before a tenant is known. Each is revoked from `PUBLIC` and granted to
`acct_app`.
**Alternatives.** An RLS policy on `users` allowing reads when `app.tenant_id` is unset; doing
authentication on the owner connection.
**Rationale.** A policy that permits reads when the tenant is unset turns every forgotten
`SET LOCAL` into a full table disclosure. A function that takes an email and returns one row is
a hole the size of the requirement, and it is greppable.

## ADR-0013 — Refresh tokens rotate, and reuse revokes the family
**Decision.** Refresh tokens are opaque random values stored as SHA-256 hashes, single-use, and
grouped by `family_id`. Presenting an already-rotated token revokes every live session in the
family.
**Alternatives.** Long-lived refresh tokens; JWT refresh tokens; rotation without reuse detection.
**Rationale.** Rotation alone does not help if a stolen token can be replayed before the victim
uses it. Treating replay as evidence of theft turns the race into a detection signal. Storing
only the hash means a database leak does not hand over live sessions.

## ADR-0014 — Posting is a separate permission from drafting, on the same endpoint
**Decision.** `POST /journal-entries` requires `ledger.entry.draft`; `status: "posted"` in the
body additionally requires `ledger.entry.post`, checked in the handler.
**Alternatives.** Two endpoints; a single permission covering both.
**Rationale.** Segregation of duties is the point of the AP/AR clerk roles — a clerk prepares,
someone else commits. One endpoint keeps the client simple; the permission check keeps the
control real. The database still enforces every posting invariant regardless of who asked.

## ADR-0015 — A cross-currency transfer posts one entry per currency, not one entry
**Decision.** Moving money between accounts in different currencies posts an entry per currency
through an `fx_clearing` account, plus a base-currency entry for the spread.
**Alternatives.** A single entry with lines in two currencies; converting one leg silently.
**Rationale.** The balancing invariant is per currency, and rightly so — an entry whose USD lines
do not balance is not made correct by JOD lines that do. Splitting it keeps every entry balanced
in its own currency and puts the spread where it can be seen.

## ADR-0016 — Reconciliation is an identity, not a status flag
**Decision.** `closing = ledger − in-transit`, and a reconciliation completes only when no
statement line is left unmatched.
**Alternatives.** Marking a reconciliation done when the operator says so.
**Rationale.** The first implementation treated unmatched statement lines as reconciling items,
which made every reconciliation appear to balance — the one outcome a reconciliation exists to
disprove. An identity that must hold is worth more than a flag somebody sets.

## ADR-0017 — Compound tax order is declared, and cycles are rejected
**Decision.** `tax_codes.compound_on` names the codes a tax is charged on top of;
`orderTaxCodes()` topologically sorts them and throws on a cycle.
**Alternatives.** A fixed precedence; evaluating in insertion order.
**Rationale.** Jordan charges General Sales Tax on a base that already includes Special Sales Tax.
Any implicit order is right by accident. A cycle has no correct answer at all, so it is refused
rather than resolved arbitrarily.

## ADR-0018 — An invoice is not a valid tax document until it is cleared
**Decision.** Clearance status, UUID and QR live on `sales_documents`, and the immutability
trigger permits exactly those columns to move after posting.
**Alternatives.** A separate clearance table; treating clearance as advisory metadata.
**Rationale.** Every reader — PDF, tax return, API consumer — must get the same answer to "is this
a valid tax document?". Putting it on the invoice makes disagreement impossible. Widening the
immutability exception to exactly those columns keeps everything else frozen.

## ADR-0019 — Statements are built from one balance query and refuse to be wrong
**Decision.** The four financial statements come from a single query over posted journal lines.
`buildBalanceSheet` computes both sides independently and throws if they differ; the cash flow
statement asserts its sections sum to the movement in cash.
**Alternatives.** Reading the balance cache; presenting whatever the numbers come to.
**Rationale.** Statements that disagree with each other, or with the trial balance, are worse than
no statements, because they are believed. A 422 is a bad day; a plausible wrong balance sheet is a
bad year.

## ADR-0020 — A soft-closed period accepts adjustments only, enforced in the trigger
**Decision.** `journal_entries.is_adjustment` gates posting into a soft-closed period; a hard close
accepts nothing.
**Alternatives.** Enforcing the distinction in the service; a single closed state.
**Rationale.** The close is itself made of postings — accruals, revaluation, reclassifications — so
a state that admits those and nothing else is the one accountants actually work in. The trigger is
the only place that cannot be bypassed by a new code path.

## ADR-0021 — Accruals post their reversal immediately
**Decision.** Creating an accrual posts both the accrual and its reversal in one request.
**Alternatives.** A scheduled job that reverses accruals at period start.
**Rationale.** An accrual whose reversal depends on a job that never runs overstates the next
period for as long as nobody notices — and nobody notices, because the number looks reasonable.
Posting both makes the reversal a fact rather than an intention.

## ADR-0022 — FX revaluation refuses a currency with no closing rate
**Decision.** `buildFxRevaluation` throws `NO_CLOSING_RATE` rather than skipping the balance.
**Alternatives.** Skipping unrated currencies; carrying the last known rate forward.
**Rationale.** Skipping silently asserts the rate did not move, which is a statement about the
world that nobody actually made. The run is cheap to repeat once the rate is entered.

## ADR-0023 — One year-end closing entry per year, enforced by a partial unique index
**Decision.** `journal_entries_one_closing_entry_per_year` allows a single posted closing entry per
fiscal year, and a year cannot hard close without one.
**Alternatives.** A service-level check; allowing repeated closes.
**Rationale.** A second closing entry doubles retained earnings, and the trial balance still
balances afterwards — so nothing downstream would catch it. That is exactly the class of error
that belongs in a constraint.

## ADR-0024 — Stock and its journal entry move in one transaction
**Decision.** Every stock movement writes the movement, its layers and its journal entry inside a
single transaction.
**Alternatives.** Posting inventory entries in a nightly batch.
**Rationale.** A batch that fails leaves stock and ledger disagreeing, and the valuation report
then has to choose which to believe. One transaction removes the question. The report still
compares the two and says so if they ever diverge.

## ADR-0025 — Issuing more stock than is on hand is refused
**Decision.** `costIssue` throws `INSUFFICIENT_STOCK`; balances and open layers are locked
`FOR UPDATE` so concurrent issues cannot both take the same stock.
**Alternatives.** Allowing negative stock valued at the last known cost, or at zero.
**Rationale.** The cost of stock that was never received is unknown, and any value assigned to it
is invented. Negative stock also understates cost of sales, which flatters profit.

## ADR-0026 — Exhausting a cost layer costs its whole remaining value
**Decision.** A FIFO layer consumed to zero contributes its remaining value, not
`unit cost × quantity`; issuing all stock under weighted average costs the entire remaining value.
**Alternatives.** Always multiplying by the unit cost and rounding.
**Rationale.** Rounding per issue leaves fractions of a fil behind in layers with no stock, and
`stock_balances` would then carry value against zero quantity — which a CHECK constraint forbids.

## ADR-0027 — Depreciation is charged once per asset per period, by constraint
**Decision.** Unique constraints on the run period and on `(asset, period_end)`.
**Alternatives.** Checking in the service before charging.
**Rationale.** Charging a month twice understates profit permanently and leaves the books in
balance, so no report reveals it. A constraint is the only guard that survives a new code path.

## ADR-0028 — CHECK constraints against nullable columns use COALESCE
**Decision.** `CHECK (method <> 'reducing_balance' OR COALESCE(annual_rate_percent, 0) > 0)`.
**Alternatives.** `annual_rate_percent > 0`.
**Rationale.** A comparison against NULL is *unknown*, and Postgres accepts unknown as satisfied.
The bare version admitted a reducing-balance asset with no rate, which has no schedule at all. The
test asserting the refusal is what caught it.

## ADR-0029 — Budget variance reads favourability from the account type
**Decision.** `isFavourable` is derived from the account type, and is `null` when the type is
unknown.
**Alternatives.** Treating a positive variance as good.
**Rationale.** Revenue below budget and expense above it are both bad news and carry opposite
signs. Colouring by sign would mark a cost overrun green. Where the type is unknown, saying
nothing beats being confidently wrong.

## ADR-0030 — An unscanned attachment is marked `skipped`, never `clean`
**Decision.** With no virus scanner configured the upload records `skipped`; a scanner that cannot
be reached fails the upload.
**Alternatives.** Defaulting to `clean` when no scanner is configured.
**Rationale.** "Not scanned" and "scanned and safe" must never be the same value in the database,
because six months later nobody remembers which deployments had a scanner. Failing closed on an
unreachable scanner keeps the two states honest.

## ADR-0031 — Company membership is derived from roles
**Decision.** `auth_tenants_for_user` derives a user's companies from `user_roles`; switching is
checked by `auth_user_belongs_to_tenant` before a token is minted, and revokes the old session.
**Alternatives.** A separate membership table; trusting the tenant id in the request.
**Rationale.** A membership list that can disagree with the roles granted will eventually disagree,
and the disagreement will be in the permissive direction. One session per company also means an
access token always names the company it may act in.
