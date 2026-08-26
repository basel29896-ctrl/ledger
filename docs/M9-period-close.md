# M9 — Period close

## What ships

| Area | Where |
| --- | --- |
| Closing entry, FX revaluation, accruals (framework-free) | `packages/domain/src/close/close.ts` |
| Schema, triggers, checklist, accrual and revaluation tables | `packages/db/migrations/0008_period_close.sql` |
| Service and endpoints | `apps/api/src/close/` |
| Screen | `apps/web/src/app/close/page.tsx` |

## Soft close and hard close

`fiscal_status` already had three states; M9 gives the middle one meaning.

- **open** — anything posts.
- **soft_closed** — only entries flagged `is_adjustment` post. That is what the
  close itself consists of: accruals, revaluation, reclassifications. Ordinary
  traffic is refused with `PERIOD_SOFT_CLOSED` (409).
- **closed** — nothing posts, adjustments included (`PERIOD_CLOSED`, 409).

The flag travels on the entry (`journal_entries.is_adjustment`, exposed as
`isAdjustment` on the create endpoint) because the trigger is the only place
that can be trusted to enforce the distinction. Application code cannot get in
front of it.

The same rules apply at the fiscal-year level, so a soft-closed year admits
adjustments across all its periods and a closed year admits nothing.

## Closing in order, and reopening

`assert_close_in_order` refuses to hard close a period while any earlier one is
open: closing March over an open February leaves a hole no report can explain,
and reopening February afterwards would silently change a signed-off March.

Reopening is allowed and is a deliberate, audited act — `fiscal_periods` is
covered by the append-only audit trigger, and reopening clears `closed_at` /
`closed_by` so the record does not claim a close that no longer holds. A period
inside a **closed year** cannot be reopened until the year is reopened first.

## Checklist

`period_close_checklist` is seeded per period on first read, so an item added to
the default list later does not rewrite history for periods already closed.
Blocking items gate the hard close (`CHECKLIST_INCOMPLETE`, 409). An item may be
**skipped**, but only with a reason — enforced both by a CHECK constraint and by
the service — and the reason is kept with the period.

Default items: bank reconciled, AR aging reviewed, AP aging reviewed, accruals
posted, FX revalued (non-blocking), tax return prepared (non-blocking), trial
balance agreed. Labels carry Arabic alongside English.

## Accruals and prepayments

`POST /api/v1/close/accruals` posts **both legs at once** — the accrual and its
reversal in the following period. An accrual whose reversal waits on a job that
may never run overstates the next period for as long as nobody notices, so the
reversal is a posted fact from the start, not a promise.

An accrual debits the expense and credits the accrued liability; a prepayment
debits the prepaid asset and credits the expense. A reversal dated on or before
the accrual is refused (`REVERSAL_NOT_AFTER_ACCRUAL`), and the same rule is a
CHECK constraint on the table.

## FX revaluation

`POST /api/v1/close/fx-revaluation` restates **monetary** balances — receivables,
payables, bank, cash, loans — at the closing rate. Inventory and fixed assets are
non-monetary and stay at the rate they were bought at.

- A currency with no closing rate is refused (`NO_CLOSING_RATE`). Revaluing
  without one would silently assume the rate had not moved.
- A debit-balance account worth more in base terms is a gain; a credit-balance
  account worth more is a loss. The same movement, the opposite sign.
- Nothing moved means no entry at all, rather than an empty one.
- `fx_revaluation_runs` is unique on `(tenant_id, as_of_date)`: revaluing the
  same date twice would double the unrealised movement.

The gain or loss is unrealised — nothing settled, only the reporting value
changed. Realised differences on settlement were handled in M6.

## Year end

`POST /api/v1/close/fiscal-years/:id/closing-entry` zeroes every P&L account on
the side opposite its balance and moves the net to retained earnings — a credit
for a profit, a debit for a loss. Guards:

- A balance sheet account in the input is refused: closing one would destroy the
  balance sheet.
- A year with nothing to close raises `NOTHING_TO_CLOSE` rather than posting an
  empty entry.
- A partial unique index allows exactly **one posted closing entry per fiscal
  year**; a second would double retained earnings.
- A year hard closes only once all its periods are closed **and** the closing
  entry is posted (`PERIODS_NOT_CLOSED`, `CLOSING_ENTRY_MISSING`).

After the closing entry, the income statement for the year reads zero and the
trial balance still balances — both asserted in the suite.

## Tests

- `packages/domain/test/close.test.ts` — 13 tests: closing entry sides, loss
  case, refusals, FX gain/loss direction, missing rate, no-op run, accrual and
  prepayment shapes.
- `packages/db/test/invariants.test.ts` — invariant 6 extended: a soft-closed
  period refuses ordinary postings and **accepts an adjustment**; closing out of
  order is refused.
- `apps/api/test/close.e2e.test.ts` — 15 tests end to end across checklist,
  soft close, accruals, revaluation, hard close, close ordering and year end,
  each checking the trial balance still balances.

Full suite after M9: **468 passing** (domain 237, einvoice-jo 16, db 56, api 159).
