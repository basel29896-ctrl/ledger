# M1 — Ledger Core

The double-entry engine. Everything later in the roadmap posts through this and
nothing may bypass it.

## What was built

### `packages/domain` — framework-free accounting logic
- **`Money`** — exact arithmetic on `bigint` minor units plus a currency. Scale comes from
  the currency (JOD 3, USD 2, JPY 0), never from a constant. `fromDecimal` *rejects* an amount
  with more precision than the currency allows rather than truncating it. `allocate` /
  `allocateEvenly` split by largest remainder so a split never creates or loses a fil.
- **FX** — `convert` rounds to the *target* currency exponent; `realisedFxDifference` computes
  gain/loss between recognition and settlement rates. Rates stay `Decimal` at full precision
  until the single final rounding.
- **Posting rules** — `validateEntry` returns every violation with a stable code
  (`UNBALANCED`, `NON_POSTABLE_ACCOUNT`, `PERIOD_CLOSED`, …); `buildReversal` mirrors an entry.
- **Trial balance** — `computeTrialBalance` folds lines into per-account totals;
  `checkAccountingEquation` asserts Assets = Liabilities + Equity + (Revenue − Expenses).

### `packages/db` — schema and invariants (`migrations/0001_ledger_core.sql`)
Tables: `tenants`, `users` (minimal), `currencies`, `exchange_rates`, `fiscal_years`,
`fiscal_periods`, `accounts`, `number_sequences`, `journal_entries`, `journal_lines`,
`account_balances`, plus `trial_balance_view`.

Section 2 invariants, all enforced in PostgreSQL:

| # | Invariant | Mechanism |
|---|---|---|
| 1 | Entries balance per currency | `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` on lines *and* headers — checked at COMMIT, and separately for base-currency amounts |
| 2 | Posted entries immutable | `BEFORE UPDATE OR DELETE` trigger; the only permitted change is the reversal link (`status`, `reversed_by_entry_id`, `reversal_reason`) |
| 3 | Balances derived | `account_balances` is a cache; `ledger_rebuild_balances()` recomputes it from zero |
| 4 | No signed amounts | `side` enum + `CHECK (amount_minor >= 0)`, zero rejected by trigger |
| 5 | Minor units + per-currency exponent | `BIGINT` + `currencies.minor_unit_exponent` |
| 6 | Closed periods locked | `assert_postable_period()` checks period *and* fiscal-year status; also rejects an entry dated outside its period |
| 7 | Idempotency | partial `UNIQUE (tenant_id, source_system, external_id)` |
| 9 | Tenant isolation | `tenant_id` on every table, `SET LOCAL app.tenant_id` per transaction — **RLS policies land in M2** |
| 10 | Trial balance sums to zero | `ledger_verify()` + `make ledger:verify` (exits non-zero on drift) |

Also: gapless `entry_no` via `allocate_document_number()` (row lock, not a sequence — a sequence
loses numbers on rollback and a tax authority does not accept a missing invoice number);
`uuid_generate_v7()`; account normal balance derived from type; parents auto-demoted to
non-postable; a period holding drafts cannot be hard-closed; `EXCLUDE USING gist` so periods
never overlap.

### `apps/api` — endpoints (`/api/v1`)
| Method | Path | Notes |
|---|---|---|
| GET/POST | `/accounts` | chart of accounts |
| POST | `/journal-entries` | draft or posted; honours `Idempotency-Key` |
| GET | `/journal-entries` | cursor pagination, `limit` max 200 |
| GET | `/journal-entries/:id` | with lines |
| POST | `/journal-entries/:id/post` | draft → posted |
| POST | `/journal-entries/:id/reverse` | posts the mirror, links both |
| GET | `/reports/trial-balance` | from journal lines, never the cache |
| GET | `/fiscal-periods` | period status |

Errors are RFC 9457 problem+json with stable codes; trigger messages are mapped
(`ENTRY_UNBALANCED`, `ENTRY_IMMUTABLE`, `PERIOD_CLOSED`, `ACCOUNT_NOT_POSTABLE`, …). Money is
always `{ amount: "1160.000", minor: "1160000", currency: "JOD" }`.

### Seed
`make seed` — 12 currencies with correct exponents, demo tenant (base JOD), admin user,
fiscal year 2026 with 12 periods, and a 43-account bilingual SME chart of accounts.

## Test results

```
@acct/domain   76 tests   (unit + property-based, fast-check)
@acct/db       40 tests   (Testcontainers, real PostgreSQL)
@acct/api      24 tests   (Supertest + Testcontainers)
              ---
              140 tests, all passing

Coverage — packages/domain: 98.25% statements, 95.17% branches (target 90%)
  posting.ts 100 | trial-balance.ts 100 | money.ts 100 | fx.ts 95.83
```

Property-based tests assert that for *any* random set of balanced postings the trial balance
sums to zero, the accounting equation ties out, reversal annihilates the original, and
allocation never creates or destroys a minor unit.

Concurrency: 100 parallel postings produce exactly 100 entries with entry numbers 1..100,
no duplicates, no gaps, and a balanced ledger.

Rebuild: `ledger_rebuild_balances` run twice produces byte-identical rows, and reproduces the
same rows after the cache is deleted entirely.

## Key decisions
ADR-0006 through ADR-0010 in `docs/DECISIONS.md`.

## Two defects found and fixed during M1
1. **Trigger firing order.** `journal_entries_assert_period` fired before the immutability
   guard, so tampering with `entry_date` on a posted entry was rejected with a confusing
   "date outside period" message instead of "posted and immutable". The immutability trigger is
   now named `journal_entries_01_immutable` so it sorts, and therefore fires, first.
2. **UUID v7 version bits.** The original bit-twiddling produced UUIDs with version nibble 0
   and no RFC 4122 variant. Fixed to explicit mask-and-set arithmetic; verified against
   generated output.

## Known gaps (deliberate, scheduled)
- **RLS is not enabled yet.** `SET LOCAL app.tenant_id` is already issued on every transaction
  so the M2 policies attach with no query changes, but today isolation is enforced by the
  `tenant_id` predicate in application queries only. This is the largest open risk in M1.
- **No audit log.** Invariant 8 is scheduled with M2 alongside auth, since it records the actor.
- **No authentication.** The tenant comes from an `X-Tenant-Id` header; M2 replaces it with a
  JWT claim. Do not expose this build to a network.
- `users` carries only id/email/display_name — roles, permissions, password hashes are M2.
- Period soft/hard close has database enforcement but no close *workflow* — that is M9.
- No UI yet; the chart of accounts and journal entry screens are M3.
- Multi-currency lines are accepted and validated, but there is no rate-lookup service or
  revaluation job — M8.
