-- =====================================================================
-- M11 — Fixed assets: register, depreciation runs, disposals.
-- =====================================================================

CREATE TYPE depreciation_method AS ENUM ('straight_line', 'reducing_balance', 'units_of_production');
CREATE TYPE asset_status AS ENUM ('draft', 'in_service', 'disposed', 'written_off');

CREATE TABLE fixed_assets (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  asset_no            TEXT NOT NULL,
  name                TEXT NOT NULL,
  name_ar             TEXT,
  category            TEXT,
  status              asset_status NOT NULL DEFAULT 'draft',
  currency_code       CHAR(3) NOT NULL REFERENCES currencies(code),
  cost_minor          BIGINT NOT NULL CHECK (cost_minor > 0),
  residual_minor      BIGINT NOT NULL DEFAULT 0 CHECK (residual_minor >= 0),
  method              depreciation_method NOT NULL,
  useful_life_months  INTEGER NOT NULL CHECK (useful_life_months > 0),
  annual_rate_percent NUMERIC(9, 4),
  total_expected_units NUMERIC(20, 4),
  acquired_on         DATE NOT NULL,
  in_service_on       DATE NOT NULL,
  disposed_on         DATE,
  /* Where the asset's postings go. Held on the asset so a depreciation run
   * never has to guess which accounts a charge belongs to. */
  asset_account_id             UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  accumulated_account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  depreciation_expense_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  disposal_gain_account_id     UUID REFERENCES accounts(id) ON DELETE RESTRICT,
  disposal_loss_account_id     UUID REFERENCES accounts(id) ON DELETE RESTRICT,
  accumulated_minor   BIGINT NOT NULL DEFAULT 0 CHECK (accumulated_minor >= 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          UUID REFERENCES users(id),
  UNIQUE (tenant_id, asset_no),
  -- An asset cannot be depreciated below what it will be worth at the end.
  CONSTRAINT fixed_assets_residual_within_cost CHECK (residual_minor <= cost_minor),
  CONSTRAINT fixed_assets_accumulated_within_depreciable
    CHECK (accumulated_minor <= cost_minor - residual_minor),
  -- COALESCE, not a bare comparison: a NULL rate would make the CHECK unknown,
  -- which Postgres accepts, and the asset would have no schedule at all.
  CONSTRAINT fixed_assets_reducing_needs_rate
    CHECK (method <> 'reducing_balance' OR COALESCE(annual_rate_percent, 0) > 0),
  CONSTRAINT fixed_assets_units_needs_total
    CHECK (method <> 'units_of_production' OR COALESCE(total_expected_units, 0) > 0),
  CONSTRAINT fixed_assets_disposed_has_date
    CHECK (status <> 'disposed' OR disposed_on IS NOT NULL),
  CONSTRAINT fixed_assets_in_service_after_acquired CHECK (in_service_on >= acquired_on)
);

CREATE INDEX fixed_assets_status_idx ON fixed_assets (tenant_id, status);

/*
 * One depreciation run per period. The unique index is the guard against
 * charging the same month twice, which would understate profit permanently.
 */
CREATE TABLE depreciation_runs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  period_end    DATE NOT NULL,
  entry_id      UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,
  total_charge_minor BIGINT NOT NULL DEFAULT 0,
  asset_count   INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID REFERENCES users(id),
  UNIQUE (tenant_id, period_end)
);

CREATE TABLE depreciation_charges (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  run_id      UUID NOT NULL REFERENCES depreciation_runs(id) ON DELETE RESTRICT,
  asset_id    UUID NOT NULL REFERENCES fixed_assets(id) ON DELETE RESTRICT,
  period_end  DATE NOT NULL,
  charge_minor BIGINT NOT NULL CHECK (charge_minor >= 0),
  accumulated_after_minor BIGINT NOT NULL,
  units_this_period NUMERIC(20, 4),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The same asset cannot be charged twice for the same month.
  UNIQUE (tenant_id, asset_id, period_end)
);

CREATE INDEX depreciation_charges_run_idx ON depreciation_charges (tenant_id, run_id);

CREATE TABLE asset_disposals (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  asset_id       UUID NOT NULL REFERENCES fixed_assets(id) ON DELETE RESTRICT,
  disposed_on    DATE NOT NULL,
  proceeds_minor BIGINT NOT NULL CHECK (proceeds_minor >= 0),
  proceeds_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  net_book_value_minor BIGINT NOT NULL,
  gain_loss_minor BIGINT NOT NULL,
  entry_id       UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,
  memo           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID REFERENCES users(id),
  -- An asset is disposed of once.
  UNIQUE (tenant_id, asset_id)
);

/* A disposed asset stops depreciating, and its terms stop moving. */
CREATE OR REPLACE FUNCTION assert_disposed_asset_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'disposed' AND (
       NEW.cost_minor IS DISTINCT FROM OLD.cost_minor
    OR NEW.residual_minor IS DISTINCT FROM OLD.residual_minor
    OR NEW.method IS DISTINCT FROM OLD.method
    OR NEW.useful_life_months IS DISTINCT FROM OLD.useful_life_months
    OR NEW.accumulated_minor IS DISTINCT FROM OLD.accumulated_minor) THEN
    RAISE EXCEPTION 'Asset % is disposed; its cost and depreciation are history', OLD.asset_no
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fixed_assets_disposed_frozen
  BEFORE UPDATE ON fixed_assets
  FOR EACH ROW EXECUTE FUNCTION assert_disposed_asset_frozen();

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['fixed_assets', 'depreciation_runs', 'depreciation_charges',
                           'asset_disposals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = current_tenant_id()) '
      'WITH CHECK (tenant_id = current_tenant_id())', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION write_audit_log()', t || '_audit', t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY['fixed_assets', 'depreciation_runs', 'asset_disposals'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t || '_set_updated_at', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO acct_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO acct_auditor;
