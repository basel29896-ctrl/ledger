-- =====================================================================
-- M12 — Budgeting.
-- =====================================================================

CREATE TYPE budget_status AS ENUM ('draft', 'approved', 'archived');

CREATE TABLE budgets (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  fiscal_year_id UUID NOT NULL REFERENCES fiscal_years(id) ON DELETE RESTRICT,
  name           TEXT NOT NULL,
  status         budget_status NOT NULL DEFAULT 'draft',
  currency_code  CHAR(3) NOT NULL REFERENCES currencies(code),
  approved_at    TIMESTAMPTZ,
  approved_by    UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID REFERENCES users(id),
  UNIQUE (tenant_id, fiscal_year_id, name)
);

/*
 * One budgeted amount per account per period. Amounts are signed: a budget is a
 * plan, not a posting, so it is not bound by the side-and-positive-amount rule
 * the ledger follows — a negative budget line is a legitimate plan to reverse
 * something.
 */
CREATE TABLE budget_lines (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  budget_id    UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  period_id    UUID NOT NULL REFERENCES fiscal_periods(id) ON DELETE RESTRICT,
  amount_minor BIGINT NOT NULL,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID REFERENCES users(id),
  UNIQUE (tenant_id, budget_id, account_id, period_id)
);

CREATE INDEX budget_lines_budget_idx ON budget_lines (tenant_id, budget_id, account_id);

/* An approved budget is the baseline a variance is measured against, so it
 * stops moving. Amend it by superseding it with a new one. */
CREATE OR REPLACE FUNCTION assert_budget_editable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status budget_status;
BEGIN
  SELECT status INTO v_status FROM budgets
   WHERE id = COALESCE(NEW.budget_id, OLD.budget_id);
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'Budget is % and its lines are fixed; supersede it with a new budget', v_status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER budget_lines_editable
  BEFORE INSERT OR UPDATE OR DELETE ON budget_lines
  FOR EACH ROW EXECUTE FUNCTION assert_budget_editable();

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['budgets', 'budget_lines'] LOOP
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
