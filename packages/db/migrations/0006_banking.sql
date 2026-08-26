-- =====================================================================
-- M6 — Banking and reconciliation.
--
-- A statement line is evidence of what the bank did. Matching it to the
-- ledger never changes an amount: it records which ledger entry the line
-- corresponds to, or creates a new posting for something the ledger missed.
-- =====================================================================

CREATE TYPE statement_format AS ENUM ('csv', 'ofx', 'mt940', 'camt053', 'manual');
CREATE TYPE statement_line_status AS ENUM ('unmatched', 'suggested', 'matched', 'ignored');
CREATE TYPE reconciliation_status AS ENUM ('in_progress', 'completed', 'abandoned');

CREATE TABLE bank_accounts (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  name              TEXT NOT NULL,
  bank_name         TEXT,
  account_number    TEXT,
  iban              TEXT,
  swift             TEXT,
  currency_code     CHAR(3) NOT NULL REFERENCES currencies(code),
  opening_balance_minor BIGINT NOT NULL DEFAULT 0,
  opening_balance_date  DATE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES users(id),
  UNIQUE (tenant_id, account_id)
);

CREATE TABLE bank_statements (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  bank_account_id   UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  format            statement_format NOT NULL,
  filename          TEXT,
  statement_date    DATE,
  opening_balance_minor BIGINT,
  closing_balance_minor BIGINT,
  -- SHA-256 of the file: importing the same statement twice is a common and
  -- expensive mistake, so the database refuses it outright.
  content_hash      TEXT NOT NULL,
  imported_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  imported_by       UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, bank_account_id, content_hash)
);

CREATE TABLE bank_statement_lines (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  statement_id      UUID NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,
  bank_account_id   UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  line_no           INTEGER NOT NULL CHECK (line_no > 0),
  external_id       TEXT,
  booking_date      DATE NOT NULL,
  value_date        DATE,
  description       TEXT NOT NULL DEFAULT '',
  reference         TEXT,
  counterparty      TEXT,
  -- Signed: positive is money into the bank account.
  amount_minor      BIGINT NOT NULL,
  status            statement_line_status NOT NULL DEFAULT 'unmatched',
  matched_entry_id  UUID REFERENCES journal_entries(id),
  matched_payment_id UUID REFERENCES payments(id),
  match_confidence  TEXT,
  match_reason      TEXT,
  matched_at        TIMESTAMPTZ,
  matched_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (statement_id, line_no)
);

CREATE INDEX bank_statement_lines_account_idx
  ON bank_statement_lines (tenant_id, bank_account_id, status);
CREATE INDEX bank_statement_lines_date_idx ON bank_statement_lines (tenant_id, booking_date);

-- A ledger entry may be claimed by only one statement line.
CREATE UNIQUE INDEX bank_statement_lines_entry_unique
  ON bank_statement_lines (matched_entry_id) WHERE matched_entry_id IS NOT NULL;

CREATE TABLE bank_rules (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  bank_account_id   UUID REFERENCES bank_accounts(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  priority          INTEGER NOT NULL DEFAULT 100,
  description_contains TEXT,
  reference_contains   TEXT,
  min_amount_minor  BIGINT CHECK (min_amount_minor IS NULL OR min_amount_minor >= 0),
  max_amount_minor  BIGINT CHECK (max_amount_minor IS NULL OR max_amount_minor >= 0),
  direction         TEXT CHECK (direction IN ('in', 'out')),
  account_id        UUID NOT NULL REFERENCES accounts(id),
  contact_id        UUID REFERENCES contacts(id),
  tax_code_id       UUID REFERENCES tax_codes(id),
  set_description   TEXT,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES users(id)
);

CREATE INDEX bank_rules_account_idx ON bank_rules (tenant_id, bank_account_id, priority);

CREATE TABLE reconciliation_sessions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  bank_account_id   UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  statement_date    DATE NOT NULL,
  statement_closing_minor BIGINT NOT NULL,
  ledger_balance_minor    BIGINT,
  difference_minor        BIGINT,
  status            reconciliation_status NOT NULL DEFAULT 'in_progress',
  completed_at      TIMESTAMPTZ,
  completed_by      UUID REFERENCES users(id),
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES users(id)
);

CREATE INDEX reconciliation_sessions_account_idx
  ON reconciliation_sessions (tenant_id, bank_account_id, statement_date);

-- Lines cleared in a completed session are locked against re-matching.
CREATE TABLE reconciliation_lines (
  session_id        UUID NOT NULL REFERENCES reconciliation_sessions(id) ON DELETE CASCADE,
  statement_line_id UUID NOT NULL REFERENCES bank_statement_lines(id) ON DELETE RESTRICT,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  cleared_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, statement_line_id)
);

/*
 * A completed reconciliation is a statement of fact: as at this date, these
 * lines were cleared and the account agreed with the bank. Re-opening it would
 * silently change a figure someone has already signed off.
 */
CREATE OR REPLACE FUNCTION assert_reconciliation_not_reopened() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'completed' AND NEW.status <> 'completed' THEN
    RAISE EXCEPTION 'Reconciliation % is completed and cannot be reopened', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'completed'
     AND (NEW.statement_closing_minor <> OLD.statement_closing_minor
          OR NEW.statement_date <> OLD.statement_date) THEN
    RAISE EXCEPTION 'Reconciliation % is completed and its figures are fixed', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER reconciliation_sessions_no_reopen
  BEFORE UPDATE ON reconciliation_sessions
  FOR EACH ROW EXECUTE FUNCTION assert_reconciliation_not_reopened();

/* A cleared line cannot be unmatched while its session stands. */
CREATE OR REPLACE FUNCTION assert_statement_line_not_locked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM reconciliation_lines rl
      JOIN reconciliation_sessions rs ON rs.id = rl.session_id
     WHERE rl.statement_line_id = OLD.id AND rs.status = 'completed'
  ) AND (NEW.matched_entry_id IS DISTINCT FROM OLD.matched_entry_id
         OR NEW.status IS DISTINCT FROM OLD.status
         OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor) THEN
    RAISE EXCEPTION
      'Statement line % was cleared in a completed reconciliation and is locked', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bank_statement_lines_locked
  BEFORE UPDATE ON bank_statement_lines
  FOR EACH ROW EXECUTE FUNCTION assert_statement_line_not_locked();

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bank_accounts', 'bank_statements', 'bank_statement_lines', 'bank_rules',
    'reconciliation_sessions', 'reconciliation_lines'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY %1$I_tenant_isolation ON %1$I
        USING (tenant_id = current_tenant_id())
        WITH CHECK (tenant_id = current_tenant_id())
    $p$, t);
    EXECUTE format('CREATE TRIGGER %1$I_audit AFTER INSERT OR UPDATE OR DELETE ON %1$I
                    FOR EACH ROW EXECUTE FUNCTION write_audit_log()', t);
    IF t <> 'reconciliation_lines' THEN
      EXECUTE format('CREATE TRIGGER %1$I_set_updated_at BEFORE UPDATE ON %1$I
                      FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END IF;
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO acct_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO acct_auditor;

INSERT INTO permissions (code, description, module) VALUES
  ('bank.write', 'Manage bank accounts and rules', 'bank'),
  ('bank.import', 'Import bank statements', 'bank')
ON CONFLICT (code) DO NOTHING;
