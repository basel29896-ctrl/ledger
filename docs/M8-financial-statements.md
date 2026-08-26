# M8 — Financial statements

## What ships

| Area | Where |
| --- | --- |
| Statement builders (framework-free) | `packages/domain/src/statements/statements.ts` |
| Balance query + CSV export | `apps/api/src/reports/statements.service.ts` |
| Endpoints | `apps/api/src/reports/statements.controller.ts` |
| Screens | `apps/web/src/app/reports/{income-statement,balance-sheet,cash-flow}` |

## Endpoints

```
GET /api/v1/reports/income-statement?fromDate&toDate[&compareFromDate&compareToDate][&format=csv]
GET /api/v1/reports/balance-sheet?asOfDate[&format=csv]
GET /api/v1/reports/cash-flow?fromDate&toDate[&format=csv]
GET /api/v1/reports/equity?fromDate&toDate[&format=csv]
```

All four require `report.read`.

## One query, four statements

Every statement is built from a single balance query that returns, per account,
the debit and credit totals **before** the window and **inside** it. Because all
four read the same rows, they cannot disagree with each other or with the trial
balance — and nothing is read from the balance cache, so a stale cache cannot
reach a statement.

Only `posted` and `reversed` entries are included. A reversal is a posting in
its own right, so both sides show and the net effect is zero.

## Sign convention

The ledger stores a side and a non-negative amount. The builders convert that to
a signed figure once, at the boundary, using the account's normal balance:
debit-normal for assets and expenses, credit-normal for the rest. Contra
accounts need no special case — accumulated depreciation is an asset with a
credit balance, so it nets against the asset it belongs to automatically.

## The balance sheet refuses to be wrong

`buildBalanceSheet` computes assets and liabilities-plus-equity independently and
throws `BALANCE_SHEET_UNBALANCED` if they differ; the API turns that into a 422.
An unbalanced balance sheet is never rendered.

Profit for the period is the balance of the **unclosed** P&L accounts, not a
figure carried from the income statement. Before the year-end close that profit
belongs in neither the equity accounts nor anywhere else, and omitting it would
put the statement out by exactly the profit.

The window splits at the start of the fiscal year containing `asOfDate`, which
is why a date no fiscal year covers returns `NO_FISCAL_YEAR` (422) instead of a
statement built on a guess.

## Cash flow: indirect, and reconciled

Every non-cash account is classified **exactly once** — P&L, non-cash add-backs,
working capital, investing, financing. Because debits equal credits, the cash
effect of the non-cash accounts is the negative of their own movement, so the
sections must sum to the movement in cash and bank. That identity is asserted:
a mismatch raises `CASH_FLOW_UNRECONCILED` rather than presenting a statement
that does not tie to the bank.

Accumulated depreciation is classified as an operating add-back, not investing,
so investing shows the gross fixed asset movement and the non-cash charge is
removed from profit — the standard presentation, and it keeps the identity
intact because each account is still counted once.

## Comparatives

Pass `compareFromDate` / `compareToDate` to the income statement. The prior
period is built the same way and reported alongside, with variance as
**current minus prior** — a fall against last year is negative. A comparative in
a different currency is rejected rather than added to a base-currency figure.

## Exports and drill-down

`format=csv` renders on the server from the same object the JSON response
carries, so an export can never show different figures from the screen. Values
are quoted and internal quotes doubled, so an account name containing a comma
cannot shift a column.

On screen, every account line links to its general ledger for the same date
range: a figure on a statement reaches its postings in one click.

## Tests

- `packages/domain/test/statements.test.ts` — 13 tests over one coherent set of
  balances, so the four statements must agree with each other; includes the
  refusal to present an unbalanced balance sheet.
- `apps/api/test/statements.e2e.test.ts` — 8 tests. The fixture is **posted
  through the ledger API**, not inserted, and the suite checks the statements
  against the trial balance, the CSV export, the comparative and its variance,
  the cash flow reconciliation, and the `NO_FISCAL_YEAR` refusal.

Full suite after M8: **439 passing** (domain 224, einvoice-jo 16, db 55, api 144).
