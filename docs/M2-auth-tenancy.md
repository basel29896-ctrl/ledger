# M2 — Authentication, Authorisation, Tenancy, Audit

Closes the two invariants M1 left open: 8 (audit trail) and 9 (tenant isolation).

## What was built

### Tenant isolation is now a database policy (invariant 9)
Fourteen tenant-scoped tables carry `ENABLE ROW LEVEL SECURITY` **and**
`FORCE ROW LEVEL SECURITY`, with one policy each:

```sql
USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())
```

`current_tenant_id()` reads `app.tenant_id`, which `Database.transaction()` sets with
`SET LOCAL` at the start of every unit of work. Two consequences worth stating plainly:

- **The API no longer connects as the owner.** It connects as `acct_app_user`, a plain login
  role inheriting `acct_app`. A superuser bypasses RLS silently, which would make every policy
  above decorative — so the tests assert `rolsuper = false` and `rolbypassrls = false` before
  asserting anything else.
- **A query that forgets the tenant returns nothing**, rather than returning everything.

Migrations, seeds and `ledger:verify` legitimately cross tenants, so they use a separate
`MIGRATION_DATABASE_URL` pointing at the owner role.

### Login needs a hole, so the hole is a small one
Login happens before any tenant is known, so it cannot run under the policy. Rather than
loosening RLS on `users`, `migrations/0003_auth_functions.sql` adds thirteen narrow
`SECURITY DEFINER` functions (`auth_find_user`, `auth_find_session`, `auth_revoke_family`, …).
Each takes an exact key, returns only what the caller needs, and is revoked from `PUBLIC` and
granted to `acct_app` alone.

### Authentication
- **Argon2id** (19 MiB, t=2, p=1 — the OWASP floor) for password hashing.
- **Access token**: 15-minute HS256 JWT in an httpOnly, SameSite=Strict cookie on `/`.
- **Refresh token**: 7-day opaque 48-byte random value, stored only as a SHA-256 hash, cookie
  scoped to `/api/v1/auth` so it never rides along on ordinary API calls.
- **Rotation with reuse detection**: each refresh token is single-use. Presenting a rotated one
  means it leaked, so the whole family is revoked, not just that token.
- **TOTP** (RFC 6238) with a ±1 step window; the secret is only armed once a code is confirmed.
- **Lockout** after 5 failed attempts for 15 minutes.
- Unknown email and wrong password return byte-identical errors, and the unknown-email path
  still spends an Argon2 hash so absence is not observable by timing.

### Authorisation
33 permissions across 8 modules; 7 seeded roles (Admin, Accountant, AR Clerk, AP Clerk,
Approver, Auditor, Viewer). `AuthGuard` is a global `APP_GUARD` — endpoints are protected by
default and opt out with `@Public()`. Handlers declare `@RequirePermissions(...)`.

Creating a journal entry needs `ledger.entry.draft`; passing `status: "posted"` on the same
endpoint additionally needs `ledger.entry.post`, because posting is the stronger act.

**The Auditor role is read-only at the database level**: `acct_auditor` holds only `SELECT`,
so an auditor session is refused by PostgreSQL, not merely by the UI.

### Audit trail (invariant 8)
`audit_log` is append-only, enforced by a `BEFORE UPDATE OR DELETE OR TRUNCATE` trigger.
A generic `write_audit_log()` trigger on accounts, journal entries, journal lines, fiscal
periods, users, user roles and exchange rates records actor, action, entity, and full
before/after JSONB images. The actor comes from `app.user_id`, set alongside `app.tenant_id`.

### Also
Helmet, strict CORS allowlist with credentials, cookie-parser, and double-submit CSRF
(`CsrfGuard`) on cookie-authenticated mutations — Bearer clients are exempt because they do not
carry ambient credentials. Company settings table. Admin endpoints for users, roles, audit log.

## Test results

```
@acct/domain    76 tests
@acct/db        55 tests  (40 ledger invariants + 15 RLS/audit)
@acct/api       48 tests  (24 ledger + 24 auth/permissions/CSRF/rotation)
               ---
               179 tests, all passing
```

The RLS suite connects as the restricted role and asserts it cannot read, update, delete or
insert across the tenant boundary, and that a query with no tenant set returns zero rows.

## Live check

```
login admin@demo.local          → 33 permissions
GET /accounts unauthenticated   → 401
GET /accounts authenticated     → 43 accounts
POST /accounts without CSRF     → 403 CSRF_TOKEN_INVALID
POST /accounts with CSRF        → 201
GET /admin/audit-log            → INSERT accounts 5900, 5280, 5270 …
```

## Key decisions
ADR-0011 through ADR-0014 in `docs/DECISIONS.md`.

## Known gaps
- Rate limiting is per-account (lockout) but not yet per-tenant or per-IP at the edge — M12.
- Sessions are not listable or revocable from the UI yet; the data is there.
- No password reset or email verification flow; Mailhog is running but unused until M4.
- `X-Tenant-Id` is gone. Multi-company switching under one login is M12, and will re-introduce
  an explicit tenant selection — validated against the user's memberships, not trusted.
