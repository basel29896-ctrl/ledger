# M6 — Banking & Reconciliation

## What was built
- **Four statement parsers** (`packages/domain/src/bank/statement-formats.ts`): CSV with a
  configurable column mapping (RFC 4180 quoting, debit/credit pair or single signed column,
  ISO / dd-mm-yyyy / yyyymmdd dates), OFX 1.x and 2.x, SWIFT MT940 (`:25:`, `:60F:`, `:61:`,
  `:86:` with continuation lines, `:62F:`), and ISO 20022 CAMT.053. One output shape; amounts
  are signed minor units, positive for money in. A file stating more decimals than the currency
  allows is an error, never a silent rounding.
- **Matching engine** (`matching.ts`): four passes — exact (amount + date + reference, where the
  reference may live in the candidate's description), amount+date when exactly one candidate
  fits, fuzzy (Dice bigram similarity on description/counterparty in a wider window), then bank
  rules. It refuses to choose between two near-equal candidates: a coin-flip match costs more
  than an unmatched line. Every suggestion carries its confidence, score and reason.
- **Bank rules**: priority-ordered conditions (description, reference, direction, amount bounds)
  that say what an unmatched line *is*. Rules never claim a ledger entry.
- **Reconciliation sessions** with a hard completion gate, and locking.
- **Bank transfers**, including cross-currency.

## Two design points worth stating

**Cross-currency transfers are three entries, not one.** Invariant 1 requires debits to equal
credits *in each currency*, and the two legs of a cross-currency transfer are in different
currencies by construction — so a single entry cannot exist. The transfer posts one entry per
currency through a currency-exchange clearing account, plus a base-currency entry for the spread
the bank kept (realised FX gain or loss). The clearing account nets to exactly zero across the
three, and the test asserts it.

**Unmatched statement lines are not reconciling items.** The first cut treated them as an
adjustment, which made every reconciliation appear to balance — the precise opposite of the
control's purpose. The identity is now
`statement closing = ledger balance − entries in transit`, and completion additionally requires
that no statement line up to the statement date is still unmatched.

## Schema (`0006_banking.sql`)
`bank_accounts`, `bank_statements` (SHA-256 content hash unique per account, so the same file
cannot be imported twice), `bank_statement_lines` (a ledger entry may be claimed by only one
line), `bank_rules`, `reconciliation_sessions`, `reconciliation_lines`.

Database-enforced: a completed reconciliation cannot be reopened or have its figures changed,
and a statement line cleared in a completed session cannot be re-matched or re-valued.

## Test results
```
@acct/domain   189 tests  (46 new: parsers, similarity, matching, rules, reconciliation)
@acct/db        55 tests
@acct/api      120 tests  (22 new banking)
              ----
              364 tests, all passing
```

## Known gaps
- Statement import takes the file content in the request body; upload to MinIO with a signed URL
  is M12.
- Bank rules can categorise a line but do not yet auto-post it; a person still confirms.
- No batch "match all suggestions" endpoint.
- Multi-currency bank accounts hold one currency each; a multi-currency account is not modelled.
- No banking screens; the API is complete and tested.
