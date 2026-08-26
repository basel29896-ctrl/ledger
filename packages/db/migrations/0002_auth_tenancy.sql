-- =====================================================================
-- M2 — Authentication, authorisation, tenant isolation, audit trail.
--
-- Tenant isolation moves from "every query remembers to filter" to a
-- PostgreSQL row-level security policy that no query can forget.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Users, roles, permissions
-- ---------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN password_hash     TEXT,
  ADD COLUMN totp_secret       TEXT,
  ADD COLUMN totp_enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN last_login_at     TIMESTAMPTZ,
  ADD COLUMN failed_logins     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN locked_until      TIMESTAMPTZ;

CREATE TABLE permissions (
  code        TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  module      TEXT NOT NULL
);

CREATE TABLE roles (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  -- System roles are seeded and cannot be deleted.
  is_system   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE role_permissions (
  role_id         UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE user_roles (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by  UUID REFERENCES users(id),
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX user_roles_tenant_idx ON user_roles (tenant_id, user_id);

-- Refresh tokens are stored hashed and rotate on every use; a replayed token
-- is evidence of theft, so the whole family is revoked.
CREATE TABLE sessions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  family_id         UUID NOT NULL,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  rotated_at        TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  revoked_reason    TEXT,
  ip                INET,
  user_agent        TEXT
);

CREATE INDEX sessions_user_idx ON sessions (user_id, revoked_at);
CREATE INDEX sessions_family_idx ON sessions (family_id);

-- ---------------------------------------------------------------------
-- Company settings (per tenant)
-- ---------------------------------------------------------------------

CREATE TABLE company_settings (
  tenant_id           UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  legal_name          TEXT NOT NULL,
  legal_name_ar       TEXT,
  tax_number          TEXT,
  address             TEXT,
  address_ar          TEXT,
  phone               TEXT,
  email               TEXT,
  logo_key            TEXT,
  fiscal_year_start_month SMALLINT NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  base_currency       CHAR(3) NOT NULL REFERENCES currencies(code),
  reporting_currency  CHAR(3) REFERENCES currencies(code),
  default_locale      TEXT NOT NULL DEFAULT 'en',
  -- Segregation of duties: bills above this need an approver who is not the creator.
  approval_threshold_minor BIGINT NOT NULL DEFAULT 0 CHECK (approval_threshold_minor >= 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Invariant 8 — append-only audit trail
-- ---------------------------------------------------------------------

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL,
  actor_id    UUID,
  actor_email TEXT,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  before      JSONB,
  after       JSONB,
  ip          INET,
  user_agent  TEXT,
  request_id  TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_tenant_time_idx ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (tenant_id, entity, entity_id);

-- Insert-only: an audit trail that can be edited is not an audit trail.
CREATE OR REPLACE FUNCTION assert_audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION assert_audit_log_append_only();

/*
 * Generic row auditor. Attached to every table whose changes must be
 * explainable to an auditor. Actor and request context come from session
 * settings the API sets at the start of each transaction.
 */
CREATE OR REPLACE FUNCTION write_audit_log() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_tenant UUID;
  v_actor  UUID;
BEGIN
  v_tenant := COALESCE(
    NULLIF(current_setting('app.tenant_id', true), '')::uuid,
    CASE TG_OP WHEN 'DELETE' THEN (to_jsonb(OLD) ->> 'tenant_id')::uuid
               ELSE (to_jsonb(NEW) ->> 'tenant_id')::uuid END
  );
  v_actor := NULLIF(current_setting('app.user_id', true), '')::uuid;

  INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, before, after, request_id)
  VALUES (
    v_tenant,
    v_actor,
    TG_OP,
    TG_TABLE_NAME,
    CASE TG_OP WHEN 'DELETE' THEN (to_jsonb(OLD) ->> 'id') ELSE (to_jsonb(NEW) ->> 'id') END,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END,
    NULLIF(current_setting('app.request_id', true), '')
  );

  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER accounts_audit         AFTER INSERT OR UPDATE OR DELETE ON accounts         FOR EACH ROW EXECUTE FUNCTION write_audit_log();
CREATE TRIGGER journal_entries_audit  AFTER INSERT OR UPDATE OR DELETE ON journal_entries  FOR EACH ROW EXECUTE FUNCTION write_audit_log();
CREATE TRIGGER journal_lines_audit    AFTER INSERT OR UPDATE OR DELETE ON journal_lines    FOR EACH ROW EXECUTE FUNCTION write_audit_log();
CREATE TRIGGER fiscal_periods_audit   AFTER INSERT OR UPDATE OR DELETE ON fiscal_periods   FOR EACH ROW EXECUTE FUNCTION write_audit_log();
CREATE TRIGGER users_audit            AFTER INSERT OR UPDATE OR DELETE ON users            FOR EACH ROW EXECUTE FUNCTION write_audit_log();
CREATE TRIGGER user_roles_audit       AFTER INSERT OR UPDATE OR DELETE ON user_roles       FOR EACH ROW EXECUTE FUNCTION write_audit_log();
CREATE TRIGGER exchange_rates_audit   AFTER INSERT OR UPDATE OR DELETE ON exchange_rates   FOR EACH ROW EXECUTE FUNCTION write_audit_log();

-- ---------------------------------------------------------------------
-- Invariant 9 — row-level security
--
-- Every tenant-scoped table gets the same policy: rows are visible and
-- writable only when they match `app.tenant_id`. FORCE makes the policy apply
-- to the table owner too, so the application role cannot quietly bypass it.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

DO $$
DECLARE
  t TEXT;
  tenant_tables TEXT[] := ARRAY[
    'users', 'exchange_rates', 'fiscal_years', 'fiscal_periods', 'accounts',
    'number_sequences', 'journal_entries', 'journal_lines', 'account_balances',
    'roles', 'user_roles', 'sessions', 'company_settings', 'audit_log'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY %1$I_tenant_isolation ON %1$I
        USING (tenant_id = current_tenant_id())
        WITH CHECK (tenant_id = current_tenant_id())
    $p$, t);
  END LOOP;
END $$;

-- Migrations, seeds and the ledger CLI run maintenance across all tenants.
-- They connect as a role holding BYPASSRLS rather than by weakening a policy.
--
-- The API must NOT connect as the table owner or as a superuser: a superuser
-- bypasses row-level security entirely, which would make the policies above
-- decorative. `acct_app` is the role the application connects through, and
-- `acct_auditor` is read-only at the database level, not merely in the UI.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acct_app') THEN
    CREATE ROLE acct_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acct_auditor') THEN
    CREATE ROLE acct_auditor NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO acct_app, acct_auditor;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO acct_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO acct_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO acct_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO acct_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO acct_app;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO acct_auditor;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO acct_auditor;

-- ---------------------------------------------------------------------
-- Permission catalogue
-- ---------------------------------------------------------------------

INSERT INTO permissions (code, description, module) VALUES
  ('ledger.account.read',    'View the chart of accounts',        'ledger'),
  ('ledger.account.write',   'Create and edit accounts',          'ledger'),
  ('ledger.entry.read',      'View journal entries',              'ledger'),
  ('ledger.entry.draft',     'Create and edit draft entries',     'ledger'),
  ('ledger.entry.post',      'Post journal entries',              'ledger'),
  ('ledger.entry.reverse',   'Reverse posted entries',            'ledger'),
  ('ledger.period.close',    'Soft-close and close periods',      'ledger'),
  ('report.read',            'View financial reports',            'reports'),
  ('ar.customer.read',       'View customers',                    'ar'),
  ('ar.customer.write',      'Create and edit customers',         'ar'),
  ('ar.invoice.read',        'View sales invoices',               'ar'),
  ('ar.invoice.write',       'Create and edit sales invoices',    'ar'),
  ('ar.payment.write',       'Record customer payments',          'ar'),
  ('ap.vendor.read',         'View vendors',                      'ap'),
  ('ap.vendor.write',        'Create and edit vendors',           'ap'),
  ('ap.bill.read',           'View vendor bills',                 'ap'),
  ('ap.bill.write',          'Create and edit vendor bills',      'ap'),
  ('ap.bill.approve',        'Approve vendor bills',              'ap'),
  ('ap.payment.write',       'Record vendor payments',            'ap'),
  ('bank.read',              'View bank accounts and statements', 'bank'),
  ('bank.reconcile',         'Reconcile bank statements',         'bank'),
  ('tax.read',               'View tax settings and returns',     'tax'),
  ('tax.write',              'Manage tax codes and returns',      'tax'),
  ('inventory.read',         'View items and stock',              'inventory'),
  ('inventory.write',        'Manage items and stock movements',  'inventory'),
  ('asset.read',             'View fixed assets',                 'assets'),
  ('asset.write',            'Manage fixed assets and runs',      'assets'),
  ('budget.read',            'View budgets',                      'budget'),
  ('budget.write',           'Manage budgets',                    'budget'),
  ('admin.user.read',        'View users and roles',              'admin'),
  ('admin.user.write',       'Manage users and role grants',      'admin'),
  ('admin.settings.write',   'Change company settings',           'admin'),
  ('admin.audit.read',       'Read the audit log',                'admin')
ON CONFLICT (code) DO NOTHING;
