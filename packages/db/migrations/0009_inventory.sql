-- =====================================================================
-- M10 — Inventory: items, warehouses, movements, cost layers, valuation.
-- =====================================================================

CREATE TYPE costing_method AS ENUM ('fifo', 'weighted_average', 'standard');
CREATE TYPE movement_kind AS ENUM ('receipt', 'issue', 'adjustment', 'transfer_in', 'transfer_out');

CREATE TABLE warehouses (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  name_ar     TEXT,
  address     TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID REFERENCES users(id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE items (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  sku                TEXT NOT NULL,
  name               TEXT NOT NULL,
  name_ar            TEXT,
  /* A service item is sold but never stocked, so it has no cost layers. */
  is_stocked         BOOLEAN NOT NULL DEFAULT TRUE,
  costing_method     costing_method NOT NULL DEFAULT 'fifo',
  unit_of_measure    TEXT NOT NULL DEFAULT 'PCE',
  currency_code      CHAR(3) NOT NULL REFERENCES currencies(code),
  standard_cost_minor BIGINT NOT NULL DEFAULT 0 CHECK (standard_cost_minor >= 0),
  sale_price_minor   BIGINT NOT NULL DEFAULT 0 CHECK (sale_price_minor >= 0),
  tax_code_id        UUID REFERENCES tax_codes(id),
  /* The three accounts an item's postings touch. Held on the item so a
   * movement never has to guess where its value goes. */
  inventory_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  cogs_account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  variance_account_id  UUID REFERENCES accounts(id) ON DELETE RESTRICT,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         UUID REFERENCES users(id),
  UNIQUE (tenant_id, sku),
  -- Standard costing without a standard cost would value every issue at zero.
  CONSTRAINT items_standard_needs_cost
    CHECK (costing_method <> 'standard' OR standard_cost_minor > 0),
  CONSTRAINT items_standard_needs_variance_account
    CHECK (costing_method <> 'standard' OR variance_account_id IS NOT NULL)
);

CREATE INDEX items_tenant_active_idx ON items (tenant_id, is_active);

/*
 * Stock movements. Quantities are NUMERIC because stock is weighed as often as
 * it is counted; costs are minor units. Every movement carries the unit cost it
 * was valued at, so a valuation can always be explained line by line.
 */
CREATE TABLE stock_movements (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  item_id        UUID NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  warehouse_id   UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  kind           movement_kind NOT NULL,
  movement_date  DATE NOT NULL,
  quantity       NUMERIC(20, 6) NOT NULL CHECK (quantity > 0),
  unit_cost_minor BIGINT NOT NULL CHECK (unit_cost_minor >= 0),
  value_minor    BIGINT NOT NULL CHECK (value_minor >= 0),
  currency_code  CHAR(3) NOT NULL REFERENCES currencies(code),
  reference      TEXT,
  memo           TEXT,
  entry_id       UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,
  source_document_id UUID,
  /* Idempotency for movements driven by another document. */
  source_system  TEXT,
  external_id    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID REFERENCES users(id)
);

CREATE UNIQUE INDEX stock_movements_idempotency
  ON stock_movements (tenant_id, source_system, external_id)
  WHERE source_system IS NOT NULL AND external_id IS NOT NULL;
CREATE INDEX stock_movements_item_idx
  ON stock_movements (tenant_id, item_id, warehouse_id, movement_date, id);

/* A posted movement is history and is corrected by another movement. */
CREATE OR REPLACE FUNCTION assert_movement_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Stock movement % cannot be deleted; post a correcting movement', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
     OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.value_minor IS DISTINCT FROM OLD.value_minor
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.movement_date IS DISTINCT FROM OLD.movement_date THEN
    RAISE EXCEPTION 'Stock movement % is posted and cannot be altered', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER stock_movements_immutable
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION assert_movement_immutable();

/*
 * FIFO cost layers. One row per receipt per warehouse; `remaining_quantity`
 * falls as the layer is consumed. The layer is the audit trail behind a cost of
 * sales figure: it names the receipt the cost came from.
 */
CREATE TABLE stock_cost_layers (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  item_id             UUID NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  warehouse_id        UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  receipt_movement_id UUID NOT NULL REFERENCES stock_movements(id) ON DELETE RESTRICT,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  movement_date       DATE NOT NULL,
  unit_cost_minor     BIGINT NOT NULL CHECK (unit_cost_minor >= 0),
  original_quantity   NUMERIC(20, 6) NOT NULL CHECK (original_quantity > 0),
  remaining_quantity  NUMERIC(20, 6) NOT NULL CHECK (remaining_quantity >= 0),
  remaining_value_minor BIGINT NOT NULL CHECK (remaining_value_minor >= 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT layers_remaining_within_original CHECK (remaining_quantity <= original_quantity)
);

CREATE INDEX stock_cost_layers_fifo_idx
  ON stock_cost_layers (tenant_id, item_id, warehouse_id, movement_date, id)
  WHERE remaining_quantity > 0;

/* Which layers an issue consumed, and for how much. */
CREATE TABLE stock_layer_consumptions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  issue_movement_id UUID NOT NULL REFERENCES stock_movements(id) ON DELETE RESTRICT,
  layer_id          UUID NOT NULL REFERENCES stock_cost_layers(id) ON DELETE RESTRICT,
  quantity          NUMERIC(20, 6) NOT NULL CHECK (quantity > 0),
  cost_minor        BIGINT NOT NULL CHECK (cost_minor >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX stock_layer_consumptions_issue_idx
  ON stock_layer_consumptions (tenant_id, issue_movement_id);

/*
 * On-hand balance per item and warehouse. Derived, like account balances:
 * it can be rebuilt from stock_movements at any time.
 */
CREATE TABLE stock_balances (
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  item_id       UUID NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  warehouse_id  UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  quantity      NUMERIC(20, 6) NOT NULL DEFAULT 0,
  value_minor   BIGINT NOT NULL DEFAULT 0,
  currency_code CHAR(3) NOT NULL REFERENCES currencies(code),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id, warehouse_id),
  -- Stock cannot be worth something when there is none of it.
  CONSTRAINT stock_balances_zero_qty_zero_value
    CHECK (quantity <> 0 OR value_minor = 0)
);

/* Rebuild every stock balance from the movements, the way ledger:rebuild does. */
CREATE OR REPLACE FUNCTION rebuild_stock_balances(p_tenant UUID) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM stock_balances WHERE tenant_id = p_tenant;
  INSERT INTO stock_balances (tenant_id, item_id, warehouse_id, quantity, value_minor, currency_code)
  SELECT m.tenant_id, m.item_id, m.warehouse_id,
         SUM(CASE WHEN m.kind IN ('receipt', 'transfer_in') THEN m.quantity
                  WHEN m.kind IN ('issue', 'transfer_out') THEN -m.quantity
                  ELSE m.quantity END),
         SUM(CASE WHEN m.kind IN ('receipt', 'transfer_in') THEN m.value_minor
                  WHEN m.kind IN ('issue', 'transfer_out') THEN -m.value_minor
                  ELSE m.value_minor END),
         m.currency_code
    FROM stock_movements m
   WHERE m.tenant_id = p_tenant
   GROUP BY m.tenant_id, m.item_id, m.warehouse_id, m.currency_code;
END $$;

-- ---------------------------------------------------------------------
-- RLS, audit, timestamps
-- ---------------------------------------------------------------------

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['warehouses', 'items', 'stock_movements', 'stock_cost_layers',
                           'stock_layer_consumptions', 'stock_balances'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = current_tenant_id()) '
      'WITH CHECK (tenant_id = current_tenant_id())', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION write_audit_log()', t || '_audit', t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY['warehouses', 'items', 'stock_movements', 'stock_cost_layers',
                           'stock_balances'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t || '_set_updated_at', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO acct_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO acct_auditor;
GRANT EXECUTE ON FUNCTION rebuild_stock_balances(UUID) TO acct_app;
