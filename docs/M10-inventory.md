# M10 — Inventory

## What ships

| Area | Where |
| --- | --- |
| Costing engine (FIFO, weighted average, standard) | `packages/domain/src/inventory/costing.ts` |
| Schema: items, warehouses, movements, layers, balances | `packages/db/migrations/0009_inventory.sql` |
| Service and endpoints | `apps/api/src/inventory/` |
| Screen | `apps/web/src/app/inventory/page.tsx` |

## Endpoints

```
GET  /api/v1/inventory/warehouses      POST /api/v1/inventory/warehouses
GET  /api/v1/inventory/items           POST /api/v1/inventory/items
POST /api/v1/inventory/receipts        POST /api/v1/inventory/issues
POST /api/v1/inventory/transfers
GET  /api/v1/inventory/items/:id/movements
GET  /api/v1/inventory/valuation[?asOfDate=]
```

Receipts and issues accept `Idempotency-Key`; a replay returns the original
movement rather than doubling the stock.

## Stock and ledger move together

Every movement changes stock **and** posts its journal entry inside one
transaction. A failure in either rolls back both, so the two cannot drift apart
through a half-finished request.

- **Receipt** — inventory is debited with what the stock is carried at, the
  offset account (normally goods received not invoiced) is credited with what
  was actually paid.
- **Issue** — cost of sales is debited and inventory credited with the cost the
  layers gave up.
- **Transfer** — no entry at all: the value never leaves the inventory account.
  Moving stock between shelves is not a revaluation and must not touch profit.

## Costing

Quantities are `NUMERIC(20,6)` because stock is weighed as often as it is
counted; costs are minor units and never touch a float.

**FIFO** keeps one cost layer per receipt per warehouse. An issue walks the
layers oldest first and records what it took in `stock_layer_consumptions`, so a
cost of sales figure can be traced back to the receipts it came from. Exhausting
a layer costs its **whole remaining value**, so rounding never strands a fil in
an empty layer.

**Weighted average** re-averages on receipt. Issuing everything costs exactly
what everything cost — the whole remaining value — rather than a per-unit
average that leaves a residue behind with no stock to carry it.

**Standard** carries stock at standard whatever was paid and books the
difference as a purchase price variance at receipt, unfavourable as a debit. An
item cannot be created at standard without a standard cost and a variance
account: both are CHECK constraints, because either missing would value every
issue at zero or drop the variance on the floor.

The costing method is fixed at creation. Changing it later would restate every
movement already posted.

## Refusals, not guesses

- Issuing more than is on hand raises `INSUFFICIENT_STOCK`. The cost of the
  shortfall is unknown, so the issue is refused rather than valued at a guess.
- If the layers ever hold less than the header quantity, `LAYERS_INCONSISTENT`
  says so instead of issuing stock that is not there.
- A service item (`is_stocked = false`) cannot take a movement.
- `stock_balances` carries a CHECK that stock cannot be worth something when
  there is none of it.
- Posted movements are immutable and are corrected by another movement, the same
  rule the ledger follows.

## Concurrency

`loadState` takes `FOR UPDATE` on the balance row and on the open cost layers, so
two concurrent issues cannot both see the same stock and both succeed.

## Valuation

`GET /inventory/valuation` reports the stock value **next to** the balance the
ledger's inventory accounts carry, and an `agreesWithLedger` flag. A
disagreement is surfaced, not smoothed over — on screen it is a red line telling
the reader to investigate before relying on either figure.

Balances are derived: `rebuild_stock_balances(tenant)` recomputes every balance
from the movements, the way `ledger:rebuild` recomputes account balances. The
suite asserts a rebuild reproduces the same rows byte for byte.

## Tests

- `packages/domain/test/inventory.test.ts` — 14 tests: FIFO layer order and
  partial consumption, insufficient stock, weighted-average re-averaging and
  rounding residue, standard cost variance direction, fractional quantities.
- `apps/api/test/inventory.e2e.test.ts` — 15 tests: the exact journal lines
  behind each movement kind, idempotent replay, transfer at carried cost,
  valuation agreeing with the ledger, rebuild reproducing the balances, and the
  trial balance still balancing.

Full suite after M10: **497 passing** (domain 251, einvoice-jo 16, db 56, api 174).
