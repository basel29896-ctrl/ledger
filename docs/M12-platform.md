# M12 — Budgeting, dashboard, multi-company, i18n and hardening

## What ships

| Area | Where |
| --- | --- |
| Budget spreading and variance | `packages/domain/src/budget/variance.ts`, `apps/api/src/budget/` |
| Multi-company membership and switching | `packages/db/migrations/0012_multi_company.sql`, `apps/api/src/auth/` |
| Attachments on MinIO/S3 | `packages/db/migrations/0013_attachments.sql`, `apps/api/src/files/` |
| E-invoice retry worker (BullMQ) | `apps/api/src/tax/clearance.queue.ts` |
| Rate limiting | `apps/api/src/app.module.ts`, `apps/api/src/auth/auth.controller.ts` |
| Commit-time secret scan | `scripts/scan-secrets.mjs` (`pnpm scan:secrets`) |
| Arabic and RTL | `apps/web/src/lib/i18n.tsx` |
| Dashboard, budget screen | `apps/web/src/app/page.tsx`, `apps/web/src/app/budget/page.tsx` |
| Playwright E2E | `apps/web/e2e/`, `apps/web/playwright.config.ts` |

## Budgeting

An annual figure spreads across the year's periods either evenly — remainder in
the final period, so the parts add back to the total exactly — or by weights,
using the same largest-remainder allocation the ledger uses for splitting money.

**Favourable is decided by account type, not by the sign of the variance.**
Revenue below budget and expense above it are both bad news and carry opposite
signs; the report says so explicitly, and where the account type is unknown it
reports `null` rather than guessing. Spending nobody budgeted for appears in the
report rather than being dropped — that is much of what a variance report is
for.

An approved budget is the baseline a variance is measured against, so its lines
stop moving: a trigger refuses edits, and an amendment is a new budget.

## Multi-company

A user's companies are **derived from the roles they hold**, never from a
separate membership list that could drift out of step with them. Two
SECURITY DEFINER functions do the cross-tenant reads that must happen before a
tenant is pinned, mirroring the login path:

- `auth_tenants_for_user` — the companies to offer, home first.
- `auth_user_belongs_to_tenant` — checked before a token is minted, so a tenant
  id posted in a request body cannot become a session in a company the user was
  never granted a role in.

Switching revokes the previous session: one session, one company, so an access
token always names the company it may act in.

## Attachments

Bytes live in object storage; the table records what exists, what it belongs to
and who put it there. The object key is stored rather than a URL, so the bucket
can move without rewriting history.

- Type allowlist checked **against the file signature**, not just the header the
  client sent.
- 20 MB cap, enforced before anything reaches storage, with the Express body
  limit mapped to the same `FILE_TOO_LARGE` problem rather than a 500.
- Reads go through a 5-minute signed URL. Nothing is served by a permanent link,
  and a file the scanner flagged is never served at all.
- The virus scan is a hook. With no scanner configured a file is marked
  `skipped`, **never `clean`** — nobody should be able to mistake "not scanned"
  for "scanned and safe" — and a scanner that cannot be reached fails the upload
  rather than silently passing it.

## E-invoice retries

A transient clearance failure is a transport problem, not an accounting one: the
invoice is posted and the ledger is unaffected. The BullMQ worker retries with
exponential backoff, capped at five attempts, keyed by document id so a double
submit is one job. A **rejection is terminal** and is never retried — a rejected
invoice needs correcting, and retrying forever would bury that. Redis is
optional: without it the API still serves and clearance falls back to the manual
endpoint.

## Hardening

- Rate limiting per IP: a burst limit and a per-minute limit, both configurable
  from the environment, with sign-in throttled harder because that is where
  guessing happens. The account lockout still applies on top.
- `scripts/scan-secrets.mjs` scans staged files for credentials before they
  enter history; gitleaks runs the deeper scan in CI. The rules deliberately
  ignore `${VAR}` references and obvious fixtures — a scanner that cries wolf
  gets ignored.
- Helmet, strict CORS allowlist, CSRF on cookie-auth mutations and Argon2id were
  already in place from M2 and are unchanged.

## Arabic and RTL

Direction is set on the document element, so the whole tree flips rather than
each screen remembering to. Numbers stay in Western digits and money keeps its
own formatting: a fils is a fils in either language, and switching numerals in
an accounting screen invites transcription mistakes. A missing translation shows
its key rather than blank space, so gaps are obvious in review.

## End-to-end

Playwright runs against a real stack (`make dev`, then `make test:e2e`), not a
mocked API: sign in, watch Post stay disabled until an entry balances, post it,
and see it reach the trial balance — plus the Arabic flip. A pass means ledger,
API and UI agree, which is the only claim an end-to-end test is worth making.

## Tests

Full suite after M12: **550 passing** (domain 274, einvoice-jo 16, db 56,
api 204), plus the Playwright suite, which needs a running stack.
