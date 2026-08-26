# M7 — Tax engine, Jordan localisation and JoFotara e-invoicing

## What ships

| Area | Where |
| --- | --- |
| Tax calculation engine | `packages/domain/src/tax/tax-engine.ts` |
| Jordan tax codes and Special Sales Tax | `packages/domain/src/tax/jordan.ts` |
| E-invoicing adapter (UBL 2.1 + QR) | `packages/einvoice-jo` |
| Schema: treatments, compounding, clearance, returns | `packages/db/migrations/0007_tax.sql` |
| API: tax codes, tax return, e-invoice submit/queue | `apps/api/src/tax/` |

## Calculation rules

- **Per-line, per-code.** A line carries one or more tax codes; each is resolved
  against its own base. The engine never assumes 16%, and never assumes two
  decimals — the currency exponent decides (JOD = 3).
- **Compounding** is declared by `compound_on`, an array of codes a tax is
  charged on top of. `orderTaxCodes()` topologically sorts the codes and
  **rejects a cycle** rather than picking an arbitrary order. This is how
  General Sales Tax on top of Special Sales Tax is modelled.
- **Inclusive pricing** back-solves the net from the gross using decimal.js at
  full precision, then rounds once, half-up, at the minor unit. Rounding is
  applied at the tax amount, never mid-chain.
- **Withholding** is deducted from a payment, is purchase-side only (enforced by
  a CHECK constraint), and never increases what the customer owes.
- **Exempt vs zero-rated** are distinct: both charge nothing, but exempt input
  tax is **not recoverable** (`isRecoverable: false`), so it lands in a
  different box on the return.

## Jordan codes seeded

GST16 (standard), GST24 (telecom), GST10/5/4/2/1 (reduced), GST0 (zero-rated),
EXEMPT, WHT5 (withholding), plus the Special Sales Tax categories, which are an
**on-top excise** — Special Sales Tax forms part of the base that General Sales
Tax is then charged on.

## Tax return

`GET /api/v1/reports/tax-return?fromDate&toDate` is built **from posted journal
lines that carry a tax code**, not from invoice headers. A return therefore
cannot disagree with the ledger, and reversals reduce it automatically. Boxes:
standard-rated sales, zero-rated sales, exempt sales, output tax, recoverable
input tax, net payable/refundable, and a per-code breakdown.

## E-invoicing (JoFotara)

- Shipped as `packages/einvoice-jo` behind an `EInvoiceProvider` interface.
  `createProvider(env)` returns the real provider when
  `JOFOTARA_CLIENT_ID` / `JOFOTARA_SECRET_KEY` are set, otherwise the mock.
  **Credentials come from env only and are never in the repo.**
- `buildUblXml()` emits UBL 2.1, type code 388 for invoices and 381 for credit
  notes (with a `BillingReference` back to the corrected document), amounts at
  the currency's own exponent, and escapes text that would break the document.
- `buildQrPayload()` emits base64 TLV carrying seller, tax number, totals and
  the clearance id.
- **An invoice is not a valid tax document until it is cleared.** The clearance
  status lives on `sales_documents` so every reader — PDF, return, API — gets
  the same answer. A cleared document cannot be silently re-cleared
  (`assert_clearance_not_overwritten`).
- 5xx/429 are classified retryable: the submission is marked `failed`, attempts
  are incremented, and the endpoint returns `CLEARANCE_RETRYABLE` (503) so the
  queue retries. Rejections are terminal and carry the reason.

## Immutability, revisited

`assert_posted_document_immutable()` is redefined in `0007` to allow exactly the
clearance columns to move after posting. Everything else on a posted document is
still frozen; corrections remain credit notes only.

## Tests

- `packages/domain` tax suites: compounding order, cycle rejection, inclusive
  back-solve, withholding, exponent handling, return construction.
- `packages/einvoice-jo`: 16 tests — UBL shape, escaping, QR TLV, mock clearance,
  rejection, retryable failure, provider selection.
- `apps/api/test/tax.e2e.test.ts`: 16 tests end to end — tax code CRUD, taxed
  sale and bill, return figures from the ledger, UBL fetch, submit, re-submit
  refused, queue drain.

Full suite at the end of M7: **418 passing** (domain 211, einvoice-jo 16, db 55,
api 136).
