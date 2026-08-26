# M3 — Manual GL UI

The first working screens. Built for a bookkeeper entering a couple of hundred lines a day,
not for a demo: dense tables, keyboard-first entry, and no decoration that costs a keystroke.

## Screens
| Route | Purpose |
|---|---|
| `/login` | Email + password, TOTP field appears only when the server asks for it |
| `/` | Trial-balance summary with a balanced / out-of-balance verdict |
| `/accounts` | Chart of accounts as an indented tree, filter, create |
| `/journal` | Entry list with status badges |
| `/journal/new` | Entry grid with live totals |
| `/journal/[id]` | Entry detail, post, reverse |
| `/reports/trial-balance` | Trial balance, date range, CSV export |
| `/reports/general-ledger` | Account detail with running balance |

## The rules from Section 9, and where they live

- **Live debit/credit totals and an out-of-balance indicator.** `journal/new` recomputes on every
  keystroke from BigInt minor units — the browser never adds money as a float.
- **Post is disabled until balanced.** `balanced` requires equal totals, a non-zero amount, at
  least two complete lines, and no amount carrying more decimals than the currency allows.
  The database re-checks all of it anyway; the button state exists to save a round trip.
- **Keyboard shortcuts.** Enter adds a line, pre-set to the side that closes the gap. Ctrl+D
  duplicates, Ctrl+S saves a draft, Ctrl+Enter posts.
- **Every number drills to its source in one click.** Trial balance row → general ledger →
  `/journal/[id]` → the entry with its lines. Each journal line links back to its account ledger.
- **Optimistic UI is banned on financial mutations.** TanStack Query mutations here have no
  `onMutate` cache write: the entry appears after the server confirms it, never before.
- **Idempotency.** The entry form generates one `Idempotency-Key` per form instance, so a
  double-click or a retried request returns the original entry instead of posting twice.

## Money handling in the browser
`lib/money.ts` converts typed decimals to minor units by string manipulation and `BigInt` only.
`toMinorUnits` returns `null` — and the field turns red — when the input carries more decimals
than the currency permits, so `1.0005` in a JOD field is rejected at the keystroke rather than
silently rounded.

## API added for this milestone
`GET /api/v1/reports/general-ledger/:accountId` — opening balance, every posted line in date
order with a running balance signed towards the account's normal balance, and closing totals.

## Verified live
```
GET / /login /accounts /journal /journal/new
    /reports/trial-balance /reports/general-ledger   → all 200

posted JE-2026-00001  cash sale 1160.000 = revenue 1000.000 + GST 160.000
posted JE-2026-00002  rent 250.000

general ledger, Cash on Hand:
  2026-03-15  JE-2026-00001  Dr 1160.000              -> 1160.000
  2026-03-20  JE-2026-00002              Cr 250.000   ->  910.000

trial balance: Dr 1410.000  Cr 1410.000  balanced=true
```

## Known gaps
- No Playwright E2E yet — that lands with the hardening pass in M12.
- The entry grid assumes the tenant base currency (JOD); multi-currency entry lines are
  accepted by the API but have no UI until M8.
- No draft editing: a draft can be posted or abandoned, not amended. M9 adds that with the
  close checklist.
- Account editing and deactivation are API-only so far.
- No Arabic UI or RTL switch yet — the data carries `name_ar` and the chart displays it, but
  the layout flips in M12.
