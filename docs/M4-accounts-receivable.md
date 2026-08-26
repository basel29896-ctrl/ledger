# M4 — Accounts Receivable

## The rule this module is built around
An invoice is a document. It does not move a balance — it *posts a journal entry*, in the same
transaction, through the same tables and the same triggers as a manual entry. There is one
ledger. The AR "sub-ledger" is a view over it, so it cannot drift.

## What was built

### Schema (`0004_ar.sql`)
`contacts` (customers and vendors in one table), `tax_codes`, `sales_documents` +
`sales_document_lines` (invoices and credit notes), `payments`, `payment_allocations`, and two
derived views: `sales_document_balances` and `payment_balances`.

Invariants, all enforced in PostgreSQL:
- **Totals match the lines.** A deferred constraint trigger compares header net/tax/gross to the
  sum of the lines at COMMIT.
- **Allocations fit.** An allocation may not exceed what the payment still holds or what the
  document still owes; it may not cross contacts or currencies; it may not touch a draft.
  Identity is checked before amounts so the error names the real problem.
- **Posted documents are immutable**, exactly like posted journal entries. Only status, void
  reason and notes may change. Corrections are credit notes.
- RLS policies and audit triggers on all six new tables.

### Ledger effects
| Document | Posting |
|---|---|
| Invoice | Dr Receivables (gross) / Cr Revenue (net, per line) / Cr Output tax (per line) |
| Credit note | the exact mirror |
| Customer receipt | Dr Bank / Cr Receivables |
| Allocation | **no GL effect** — it records which invoice stopped being owed |

That last row is the design point: the receipt already moved the money. Allocation is
sub-ledger bookkeeping, and giving it its own journal entry would double-count.

### Domain (`packages/domain/src/ar/`)
- `calculateLine` / `calculateInvoice` — quantity extension, tax exclusive and inclusive,
  **rounded once per line**. Three lines of 0.333 JOD at 16% give 0.159 tax, not 0.160: rounding
  the document total once would be a fil adrift and would not reconcile line by line.
- `dueDateFor` — net terms in days, leap years included.
- `bucketFor` / `buildAgingReport` — current / 1–30 / 31–60 / 61–90 / 91–120 / 120+. A document
  due today is *current*, not overdue.
- `allocateOldestFirst` — settles by due date; an overpayment stays unapplied rather than being
  forced onto an invoice, because it is a real balance owed back to the customer.
- `validateAllocation` — mirrors the database trigger for a useful API error.

### API
`/customers` (list, create, statement), `/sales-documents` (create draft or post, list, get,
post, void, **PDF**), `/customer-receipts` (create with automatic or explicit allocation, list,
allocate), `/reports/ar-aging`.

The PDF carries the fields a Jordanian tax invoice requires: supplier name, address and tax
number; sequential number; issue date; itemised description with quantity and value; buyer name
and TIN; totals; tax rate and amount. It prints a warning that the document is not a valid tax
invoice until cleared by the national system — clearance arrives in M7.

## Test results
```
@acct/domain   118 tests  (42 new: invoice maths, due dates, aging, allocation)
@acct/db        55 tests
@acct/api       73 tests  (25 new AR)
              ----
              246 tests, all passing
```

The AR suite ends by tying the AR control account back to the sub-ledger:
`control balance = open invoices − credit notes − receipts not yet applied`, and asserts
`ledger_verify` reports no imbalance after every step.

## Verified live
```
INV-2026-00001  open   net 1000.000  tax 160.000  gross 1160.000  due 2026-05-01
allocate 500.000 on account          → outstanding 660.000, still open
aging as of 2026-06-30               → CUST-001  660.000 in the 31–60 bucket
trial balance                        → balanced = true
invoice PDF                          → 200, 1993 bytes, %PDF-1.3
```

## Two defects found and fixed
1. **One trigger function serving two tables.** `assert_document_totals()` referenced both
   `NEW.id` and `NEW.document_id`; plpgsql resolves every field reference regardless of branch,
   so it failed on whichever table lacked the other column. Split into a shared
   `check_document_totals(uuid)` plus two thin trigger functions.
2. **Allocation errors named the wrong problem.** Amount limits were checked before identity, so
   allocating to another contact's invoice reported "exceeds the document total". Identity now
   comes first.

## Known gaps
- Quotes, sales orders and delivery notes are not built — only the invoice itself.
- Recurring invoices, dunning reminders and the customer portal are deferred to M12.
- Write-offs and bad-debt provisioning are not implemented; the accounts exist in the COA.
- Batch receipts are supported by the allocation API but have no dedicated endpoint.
- No AR screens yet — the API is complete and tested; UI arrives with the M12 pass.
- Arabic text in the PDF needs an embedded font with Arabic shaping; the current PDF is
  English-only. That lands with the RTL work in M12.
