# M11 — Fixed assets

## What ships

| Area | Where |
| --- | --- |
| Depreciation and disposal maths | `packages/domain/src/assets/depreciation.ts` |
| Register, runs, charges, disposals | `packages/db/migrations/0010_fixed_assets.sql` |
| Service and endpoints | `apps/api/src/assets/` |
| Screen | `apps/web/src/app/assets/page.tsx` |

## Endpoints

```
GET  /api/v1/assets                    POST /api/v1/assets
GET  /api/v1/assets/register
GET  /api/v1/assets/:id/schedule
POST /api/v1/assets/depreciation-runs
POST /api/v1/assets/:id/disposal
```

## Two rules run through the maths

1. An asset is **never depreciated below its residual value**. The last charge
   is whatever is left, not a full monthly charge.
2. The total charged over a life equals the depreciable amount **exactly**. The
   rounding difference lands in the final period rather than being smeared as a
   fraction of a fil across every one.

## Methods

- **Straight line** — the depreciable amount spread evenly, with the final month
  absorbing the remainder.
- **Reducing balance** — an annual rate charged monthly on the written-down
  value, so the charge falls each year, capped at the residual. An asset with no
  rate is refused: without one there is no schedule.
- **Units of production** — charged in proportion to what the asset actually
  produced. It has **no schedule in advance**, and a run must supply the units
  for the period; guessing them would be inventing depreciation.

The database enforces the same rules: `COALESCE(annual_rate_percent, 0) > 0` for
reducing balance and `COALESCE(total_expected_units, 0) > 0` for units. The
COALESCE matters — a bare `annual_rate_percent > 0` is *unknown* for NULL, which
Postgres accepts, and the asset would have slipped in with no schedule at all.
That was a real bug in this milestone, caught by the test that asserts the
refusal.

## Depreciation runs

A run charges every in-service asset once for a period end and posts **one**
journal entry for the total: depreciation expense debited, accumulated
depreciation credited. The whole run is a single transaction — either every
asset is charged and the entry posted, or nothing moves.

Two unique constraints guard the arithmetic:

- `depreciation_runs (tenant_id, period_end)` — a period is run once.
- `depreciation_charges (tenant_id, asset_id, period_end)` — an asset is charged
  once per month, even across runs.

Charging a month twice understates profit permanently and nothing downstream
would notice, which is why this is a constraint and not a code check. Assets are
selected `FOR UPDATE`, so two concurrent runs cannot both charge the same asset.

A run with nothing to charge posts no entry at all rather than an empty one.

## Disposal

Cost and accumulated depreciation both come off in full, the proceeds land where
they were received, and the difference is a gain or a loss — nothing is left on
the balance sheet. An asset is disposed of once (unique constraint), a disposed
asset stops depreciating, and a trigger freezes its cost, method and accumulated
depreciation: after disposal they are history.

`disposalResult` refuses accumulated depreciation greater than cost — a register
in that state would post a false gain.

## Tests

- `packages/domain/test/assets.test.ts` — 15 tests: even spread, exact landing on
  residual, rounding in the final period, reducing balance falling year on year
  and never breaching the residual, units of production, final-charge capping,
  disposal gain and loss.
- `apps/api/test/assets.e2e.test.ts` — 11 tests: register totals, the refusal of
  a reducing-balance asset with no rate, the 60-row schedule, the exact journal
  lines behind a run and a disposal, the same period refused twice, accumulated
  depreciation carried forward, a disposed asset dropping out of later runs, and
  the trial balance still balancing.

Full suite after M11: **523 passing** (domain 266, einvoice-jo 16, db 56, api 185).
