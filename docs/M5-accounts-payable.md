# M5 — Accounts Payable

Purchase requisition → order → goods receipt → vendor bill → three-way match → approval →
payment. Two controls run the module: the **match** says the goods arrived at the agreed price;
the **approval** says a person accepts the spend. They are separate gates on purpose.

## What was built

### Schema (`0005_ap.sql`)
`purchase_orders` + lines, `goods_receipts` + lines, `purchase_documents` + lines (bills and
debit notes), `bill_approvals`, `purchase_allocations`, plus `purchase_document_balances`,
`vendor_payment_balances` and `purchase_order_line_progress` (ordered / received / billed per
PO line).

Database-enforced:
- **Segregation of duties.** `assert_approver_is_not_creator()` refuses an approval where the
  approver entered the bill and the total exceeds `company_settings.approval_threshold_minor`.
  Enforced in the database because the UI is not the only way in.
- **Duplicate bill protection.** A partial unique index on
  `(tenant, contact, vendor_invoice_no)` — the same supplier invoice number cannot be entered
  twice, though two different suppliers may of course use the same number.
- **Allocations fit**, identity checked before amounts, as in AR.
- **Totals match lines**, deferred to COMMIT.
- **Posted bills are immutable**; corrections are debit notes.

### Three-way match (`packages/domain/src/ap/three-way-match.ts`)
Compares ordered, received and billed quantities plus the unit price, with configurable
tolerances (percentage on quantity, percentage-or-absolute on price). Exception codes:
`NOT_RECEIVED`, `BILLED_MORE_THAN_RECEIVED`, `BILLED_MORE_THAN_ORDERED`,
`RECEIVED_MORE_THAN_ORDERED`, `PRICE_VARIANCE`. Every exception carries the numbers that
produced it, because an exception queue that says only "mismatch" makes the clerk redo the work.

A bill with no purchase order behind it is `not_required` rather than a failure — not everything
is bought on a PO.

### Approval routing
`canApprove()` refuses on missing permission, on unresolved match exceptions, and on
segregation of duties. An approver may override a match exception with a stated reason, which is
recorded on the bill; only then can it be approved.

Approval and posting happen in one transaction: an approved bill that is not in the ledger is
an unrecorded liability.

### Ledger effects
| Document | Posting |
|---|---|
| Vendor bill | Dr Expense (net, per line) / Dr Input tax / Cr Payables (gross) |
| Debit note | the exact mirror |
| Vendor payment | Dr Payables / Cr Bank |
| Purchase order | **nothing** — an order is a commitment, not a transaction |
| Goods receipt | nothing yet; perpetual inventory posting arrives with M10 |

### API
`/vendors`, `/purchase-orders`, `/goods-receipts`, `/bills` (create, list, get, `/match`,
`/override-match`, `/approve`, `/reject`, `/match-exceptions`), `/vendor-payments` (+ `/run`
payment run grouped by vendor), `/reports/ap-aging`, `/reports/cash-requirements`.

## Test results
```
@acct/domain   143 tests  (25 new: match, tolerances, approval routing, cash forecast)
@acct/db        55 tests
@acct/api       98 tests  (25 new AP)
              ----
              296 tests, all passing
```

Highlights from the AP suite:
- the entering clerk is refused as approver above the threshold — **and** the same insert is
  refused directly at the database, proving the control is not merely service-level;
- approval is refused while a match exception stands, and allowed after an override with reason;
- a bill still awaiting approval cannot be paid;
- the AP control account ties to the sub-ledger:
  `control = outstanding bills − payments not yet applied`;
- `ledger_verify` reports no imbalance after the whole chain.

## Known gaps
- Purchase requisitions (the step before an order) are not built; orders are created directly.
- Approval rules are a single tenant-wide threshold. Per-cost-centre and multi-step approval
  chains are not implemented.
- Vendor prepayments and advances, and expense claims, are not built.
- Goods receipts do not yet move stock — that is M10, where the GRN posts to inventory and the
  bill clears the goods-received-not-invoiced account.
- No AP screens; the API is complete and tested.
