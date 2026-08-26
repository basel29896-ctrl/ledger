-- =====================================================================
-- M9 — Period close: soft and hard close, checklist, accruals,
-- FX revaluation, and the year-end closing entry.
-- =====================================================================

/*
 * A soft close stops ordinary traffic but still admits adjustments, which is
 * what the close itself is made of: accruals, revaluation, reclassifications.
 * A hard close admits nothing at all. The distinction has to live on the entry,
 * because the trigger is the only place that can be trusted to enforce it.
 */
ALTER TABLE journal_entries
  ADD COLUMN is_adjustment    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN is_closing_entry BOOLEAN NOT NULL DEFAULT FALSE;

-- One posted year-end closing entry per fiscal year; a second would double
-- retained earnings.
CREATE UNIQUE INDEX journal_entries_one_closing_entry_per_year
  ON journal_entries (tenant_id, fiscal_year_id)
  WHERE is_closing_entry AND status = 'posted';

CREATE OR REPLACE FUNCTION assert_postable_period() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  per     fiscal_periods%ROWTYPE;
  fy      fiscal_years%ROWTYPE;
  alloc   RECORD;
BEGIN
  SELECT * INTO per FROM fiscal_periods WHERE id = NEW.period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry references an unknown fiscal period'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF per.tenant_id <> NEW.tenant_id THEN
    RAISE EXCEPTION 'Fiscal period belongs to another tenant'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.entry_date < per.start_date OR NEW.entry_date > per.end_date THEN
    RAISE EXCEPTION 'Entry date % is outside period % (% to %)',
      NEW.entry_date, per.period_no, per.start_date, per.end_date
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO fy FROM fiscal_years WHERE id = per.fiscal_year_id;
  NEW.fiscal_year_id := fy.id;

  IF NEW.status <> 'draft' THEN
    IF per.status = 'closed' THEN
      RAISE EXCEPTION 'Fiscal period % is closed and will not accept postings', per.period_no
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF per.status = 'soft_closed' AND NOT NEW.is_adjustment THEN
      RAISE EXCEPTION
        'Fiscal period % is soft closed: only adjustments may be posted into it', per.period_no
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF fy.status = 'closed' THEN
      RAISE EXCEPTION 'Fiscal year % is closed and will not accept postings', fy.name
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF fy.status = 'soft_closed' AND NOT NEW.is_adjustment THEN
      RAISE EXCEPTION
        'Fiscal year % is soft closed: only adjustments may be posted into it', fy.name
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.entry_no IS NULL THEN
      SELECT * INTO alloc FROM allocate_document_number(NEW.tenant_id, 'journal_entry', fy.id::text);
      NEW.entry_no := alloc.allocated_value;
      NEW.entry_ref := alloc.formatted;
    END IF;
    IF NEW.posted_at IS NULL THEN
      NEW.posted_at := now();
    END IF;
  END IF;

  RETURN NEW;
END $$;

/*
 * A period may only be hard closed once every earlier period is closed:
 * closing March while February is open would leave a hole no report could
 * explain, and reopening February later would change a signed-off March.
 */
CREATE OR REPLACE FUNCTION assert_close_in_order() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_open INTEGER;
BEGIN
  IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
    SELECT count(*) INTO v_open
      FROM fiscal_periods p
     WHERE p.tenant_id = NEW.tenant_id
       AND p.end_date < NEW.start_date
       AND p.status <> 'closed';
    IF v_open > 0 THEN
      RAISE EXCEPTION
        'Cannot close period %: % earlier period(s) are still open', NEW.period_no, v_open
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- Reopening is allowed, deliberately and audibly, but never for a closed year.
  IF OLD.status = 'closed' AND NEW.status <> 'closed' THEN
    IF (SELECT status FROM fiscal_years WHERE id = NEW.fiscal_year_id) = 'closed' THEN
      RAISE EXCEPTION
        'Period % belongs to a closed fiscal year; reopen the year first', NEW.period_no
        USING ERRCODE = 'restrict_violation';
    END IF;
    NEW.closed_at := NULL;
    NEW.closed_by := NULL;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER fiscal_periods_assert_close_order
  BEFORE UPDATE ON fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION assert_close_in_order();

/* A year closes only when all of its periods are closed. */
CREATE OR REPLACE FUNCTION assert_year_closable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_open INTEGER;
  v_closing INTEGER;
BEGIN
  IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
    SELECT count(*) INTO v_open
      FROM fiscal_periods WHERE fiscal_year_id = NEW.id AND status <> 'closed';
    IF v_open > 0 THEN
      RAISE EXCEPTION 'Cannot close year %: % period(s) are not closed', NEW.name, v_open
        USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT count(*) INTO v_closing
      FROM journal_entries
     WHERE fiscal_year_id = NEW.id AND is_closing_entry AND status = 'posted';
    IF v_closing = 0 THEN
      RAISE EXCEPTION
        'Cannot close year %: the year-end closing entry has not been posted', NEW.name
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fiscal_years_assert_closable
  BEFORE UPDATE ON fiscal_years
  FOR EACH ROW EXECUTE FUNCTION assert_year_closable();

-- ---------------------------------------------------------------------
-- Close checklist
-- ---------------------------------------------------------------------

CREATE TYPE checklist_status AS ENUM ('pending', 'done', 'skipped');

CREATE TABLE period_close_checklist (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  period_id     UUID NOT NULL REFERENCES fiscal_periods(id) ON DELETE CASCADE,
  item_code     TEXT NOT NULL,
  label         TEXT NOT NULL,
  label_ar      TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  /* A blocking item must be done before the period may be hard closed. */
  is_blocking   BOOLEAN NOT NULL DEFAULT TRUE,
  status        checklist_status NOT NULL DEFAULT 'pending',
  notes         TEXT,
  completed_at  TIMESTAMPTZ,
  completed_by  UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID REFERENCES users(id),
  UNIQUE (tenant_id, period_id, item_code),
  CONSTRAINT checklist_skip_needs_reason
    CHECK (status <> 'skipped' OR (notes IS NOT NULL AND length(btrim(notes)) > 0))
);

CREATE INDEX period_close_checklist_period_idx ON period_close_checklist (tenant_id, period_id);

/* Blocking items gate the hard close. Skipping one is allowed but must be
 * explained, and the explanation is kept — that is the point of the checklist. */
CREATE OR REPLACE FUNCTION assert_checklist_complete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_pending TEXT;
BEGIN
  IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
    SELECT string_agg(label, ', ' ORDER BY sort_order) INTO v_pending
      FROM period_close_checklist
     WHERE period_id = NEW.id AND is_blocking AND status = 'pending';
    IF v_pending IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot close period %: outstanding checklist items — %',
        NEW.period_no, v_pending
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fiscal_periods_assert_checklist
  BEFORE UPDATE ON fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION assert_checklist_complete();

-- ---------------------------------------------------------------------
-- Accruals and prepayments
-- ---------------------------------------------------------------------

CREATE TYPE accrual_kind AS ENUM ('accrual', 'prepayment');

CREATE TABLE accruals (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  kind               accrual_kind NOT NULL,
  memo               TEXT NOT NULL,
  amount_minor       BIGINT NOT NULL CHECK (amount_minor > 0),
  currency_code      CHAR(3) NOT NULL REFERENCES currencies(code),
  pl_account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  balance_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  accrual_date       DATE NOT NULL,
  reversal_date      DATE NOT NULL,
  accrual_entry_id   UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,
  reversal_entry_id  UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         UUID REFERENCES users(id),
  CONSTRAINT accruals_reverse_after CHECK (reversal_date > accrual_date),
  CONSTRAINT accruals_distinct_accounts CHECK (pl_account_id <> balance_account_id)
);

CREATE INDEX accruals_pending_reversal_idx
  ON accruals (tenant_id, reversal_date) WHERE reversal_entry_id IS NULL;

-- ---------------------------------------------------------------------
-- FX revaluation runs
-- ---------------------------------------------------------------------

CREATE TABLE fx_revaluation_runs (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  as_of_date     DATE NOT NULL,
  base_currency  CHAR(3) NOT NULL REFERENCES currencies(code),
  net_gain_minor BIGINT NOT NULL,
  entry_id       UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,
  detail         JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID REFERENCES users(id),
  -- Revaluing the same date twice would double the unrealised movement.
  UNIQUE (tenant_id, as_of_date)
);

-- ---------------------------------------------------------------------
-- RLS, audit, timestamps
-- ---------------------------------------------------------------------

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['period_close_checklist', 'accruals', 'fx_revaluation_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = current_tenant_id()) '
      'WITH CHECK (tenant_id = current_tenant_id())', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION write_audit_log()', t || '_audit', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t || '_set_updated_at', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO acct_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO acct_auditor;

INSERT INTO permissions (code, description, module) VALUES
  ('ledger.period.reopen', 'Reopen a closed fiscal period', 'ledger'),
  ('ledger.close.run',     'Run close routines: accruals, revaluation, year end', 'ledger')
ON CONFLICT (code) DO NOTHING;
