-- =====================================================================
-- M5 — Accounts Payable.
--
-- Purchase requisition → order → goods receipt → vendor bill, with a
-- three-way match and an approval workflow that enforces segregation of
-- duties in the database, not merely in the UI.
-- =====================================================================

CREATE TYPE purchase_order_status AS ENUM ('draft', 'approved', 'partially_received', 'received', 'closed', 'cancelled');
CREATE TYPE purchase_doc_type AS ENUM ('bill', 'debit_note');
CREATE TYPE purchase_doc_status AS ENUM ('draft', 'pending_approval', 'approved', 'open', 'paid', 'void');
CREATE TYPE match_status AS ENUM ('not_required', 'matched', 'exception', 'overridden');

-- ---------------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------------

CREATE TABLE purchase_orders (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  po_no             BIGINT,
  po_ref            TEXT,
  contact_id        UUID NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  order_date        DATE NOT NULL,
  expected_date     DATE,
  currency_code     CHAR(3) NOT NULL REFERENCES currencies(code),
  status            purchase_order_status NOT NULL DEFAULT 'draft',
  subtotal_minor    BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  tax_total_minor   BIGINT NOT NULL DEFAULT 0 CHECK (tax_total_minor >= 0),
  total_minor       BIGINT NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  notes             TEXT,
  approved_at       TIMESTAMPTZ,
  approved_by       UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES users(id)
);

CREATE UNIQUE INDEX purchase_orders_no_unique
  ON purchase_orders (tenant_id, po_no) WHERE po_no IS NOT NULL;
CREATE INDEX purchase_orders_contact_idx ON purchase_orders (tenant_id, contact_id, status);

CREATE TABLE purchase_order_lines (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  order_id          UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_no           INTEGER NOT NULL CHECK (line_no > 0),
  description       TEXT NOT NULL,
  quantity          NUMERIC(18, 4) NOT NULL CHECK (quantity > 0),
  unit_price_minor  BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor  BIGINT NOT NULL CHECK (line_total_minor >= 0),
  tax_code_id       UUID REFERENCES tax_codes(id),
  tax_amount_minor  BIGINT NOT NULL DEFAULT 0 CHECK (tax_amount_minor >= 0),
  expense_account_id UUID NOT NULL REFERENCES accounts(id),
  item_id           UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, line_no)
);

-- ---------------------------------------------------------------------
-- Goods receipts
-- ---------------------------------------------------------------------

CREATE TABLE goods_receipts (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  grn_no            BIGINT,
  grn_ref           TEXT,
  order_id          UUID REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  contact_id        UUID NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  received_date     DATE NOT NULL,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES users(id)
);

CREATE UNIQUE INDEX goods_receipts_no_unique
  ON goods_receipts (tenant_id, grn_no) WHERE grn_no IS NOT NULL;

CREATE TABLE goods_receipt_lines (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  receipt_id        UUID NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  line_no           INTEGER NOT NULL CHECK (line_no > 0),
  order_line_id     UUID REFERENCES purchase_order_lines(id) ON DELETE RESTRICT,
  description       TEXT NOT NULL,
  quantity_received NUMERIC(18, 4) NOT NULL CHECK (quantity_received > 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (receipt_id, line_no)
);

CREATE INDEX goods_receipt_lines_order_line_idx ON goods_receipt_lines (order_line_id);

-- ---------------------------------------------------------------------
-- Vendor bills
-- ---------------------------------------------------------------------

CREATE TABLE purchase_documents (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  doc_type          purchase_doc_type NOT NULL DEFAULT 'bill',
  doc_no            BIGINT,
  doc_ref           TEXT,
  -- The vendor's own invoice number, unique per vendor: the first line of
  -- defence against paying the same bill twice.
  vendor_invoice_no TEXT,
  contact_id        UUID NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  order_id          UUID REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  issue_date        DATE NOT NULL,
  due_date          DATE NOT NULL,
  currency_code     CHAR(3) NOT NULL REFERENCES currencies(code),
  fx_rate           NUMERIC(20, 10) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
  subtotal_minor    BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  tax_total_minor   BIGINT NOT NULL DEFAULT 0 CHECK (tax_total_minor >= 0),
  total_minor       BIGINT NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  status            purchase_doc_status NOT NULL DEFAULT 'draft',
  match_status      match_status NOT NULL DEFAULT 'not_required',
  match_notes       TEXT,
  journal_entry_id  UUID REFERENCES journal_entries(id),
  approved_at       TIMESTAMPTZ,
  approved_by       UUID REFERENCES users(id),
  void_reason       TEXT,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES users(id),
  CONSTRAINT purchase_documents_dates CHECK (due_date >= issue_date),
  CONSTRAINT purchase_documents_posted_has_number
    CHECK (status IN ('draft', 'pending_approval', 'approved')
           OR (doc_no IS NOT NULL AND journal_entry_id IS NOT NULL))
);

CREATE UNIQUE INDEX purchase_documents_no_unique
  ON purchase_documents (tenant_id, doc_type, doc_no) WHERE doc_no IS NOT NULL;
-- A vendor invoice number may appear once per vendor.
CREATE UNIQUE INDEX purchase_documents_vendor_invoice_unique
  ON purchase_documents (tenant_id, contact_id, vendor_invoice_no)
  WHERE vendor_invoice_no IS NOT NULL;
CREATE INDEX purchase_documents_contact_idx ON purchase_documents (tenant_id, contact_id, status);
CREATE INDEX purchase_documents_due_idx ON purchase_documents (tenant_id, due_date) WHERE status = 'open';

CREATE TABLE purchase_document_lines (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  document_id       UUID NOT NULL REFERENCES purchase_documents(id) ON DELETE CASCADE,
  line_no           INTEGER NOT NULL CHECK (line_no > 0),
  order_line_id     UUID REFERENCES purchase_order_lines(id) ON DELETE RESTRICT,
  description       TEXT NOT NULL,
  quantity          NUMERIC(18, 4) NOT NULL CHECK (quantity > 0),
  unit_price_minor  BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor  BIGINT NOT NULL CHECK (line_total_minor >= 0),
  tax_code_id       UUID REFERENCES tax_codes(id),
  tax_amount_minor  BIGINT NOT NULL DEFAULT 0 CHECK (tax_amount_minor >= 0),
  expense_account_id UUID NOT NULL REFERENCES accounts(id),
  item_id           UUID,
  cost_center_id    UUID,
  project_id        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, line_no)
);

-- ---------------------------------------------------------------------
-- Approvals
-- ---------------------------------------------------------------------

CREATE TABLE bill_approvals (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  document_id       UUID NOT NULL REFERENCES purchase_documents(id) ON DELETE CASCADE,
  approver_id       UUID NOT NULL REFERENCES users(id),
  decision          TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason            TEXT,
  decided_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX bill_approvals_document_idx ON bill_approvals (document_id);

/*
 * Segregation of duties.
 *
 * Above the tenant approval threshold the person who entered a bill may not be
 * the person who approves it. This is enforced here because the UI is not the
 * only way in, and because a control nobody can bypass is the only kind worth
 * describing to an auditor.
 */
CREATE OR REPLACE FUNCTION assert_approver_is_not_creator() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_doc       RECORD;
  v_threshold BIGINT;
BEGIN
  SELECT created_by, total_minor INTO v_doc
    FROM purchase_documents WHERE id = NEW.document_id;

  SELECT COALESCE(approval_threshold_minor, 0) INTO v_threshold
    FROM company_settings WHERE tenant_id = NEW.tenant_id;

  IF NEW.decision = 'approved'
     AND v_doc.created_by IS NOT NULL
     AND v_doc.created_by = NEW.approver_id
     AND v_doc.total_minor > COALESCE(v_threshold, 0) THEN
    RAISE EXCEPTION
      'Segregation of duties: the user who entered this bill cannot approve it above the % threshold',
      COALESCE(v_threshold, 0)
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER bill_approvals_segregation_of_duties
  BEFORE INSERT ON bill_approvals
  FOR EACH ROW EXECUTE FUNCTION assert_approver_is_not_creator();

-- ---------------------------------------------------------------------
-- Vendor payment allocation
-- ---------------------------------------------------------------------

CREATE TABLE purchase_allocations (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  payment_id        UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  document_id       UUID NOT NULL REFERENCES purchase_documents(id) ON DELETE RESTRICT,
  amount_minor      BIGINT NOT NULL CHECK (amount_minor > 0),
  allocated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  allocated_by      UUID REFERENCES users(id),
  UNIQUE (payment_id, document_id)
);

CREATE INDEX purchase_allocations_document_idx ON purchase_allocations (document_id);

CREATE OR REPLACE VIEW purchase_document_balances AS
SELECT d.id AS document_id,
       d.tenant_id,
       d.contact_id,
       d.doc_type,
       d.doc_ref,
       d.vendor_invoice_no,
       d.issue_date,
       d.due_date,
       d.currency_code,
       d.status,
       d.total_minor,
       COALESCE(a.allocated_minor, 0)::bigint AS allocated_minor,
       (d.total_minor - COALESCE(a.allocated_minor, 0))::bigint AS outstanding_minor
  FROM purchase_documents d
  LEFT JOIN (
    SELECT document_id, SUM(amount_minor) AS allocated_minor
      FROM purchase_allocations GROUP BY document_id
  ) a ON a.document_id = d.id
 WHERE d.status <> 'void';

CREATE OR REPLACE VIEW vendor_payment_balances AS
SELECT p.id AS payment_id,
       p.tenant_id,
       p.contact_id,
       p.payment_date,
       p.currency_code,
       p.amount_minor,
       COALESCE(a.allocated_minor, 0)::bigint AS allocated_minor,
       (p.amount_minor - COALESCE(a.allocated_minor, 0))::bigint AS unapplied_minor
  FROM payments p
  LEFT JOIN (
    SELECT payment_id, SUM(amount_minor) AS allocated_minor
      FROM purchase_allocations GROUP BY payment_id
  ) a ON a.payment_id = p.id
 WHERE p.direction = 'paid' AND p.status <> 'void';

CREATE OR REPLACE FUNCTION assert_purchase_allocation_within_limits() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_payment  RECORD;
  v_document RECORD;
BEGIN
  SELECT p.amount_minor, p.currency_code, p.contact_id,
         COALESCE((SELECT SUM(amount_minor) FROM purchase_allocations WHERE payment_id = p.id), 0) AS allocated
    INTO v_payment
    FROM payments p WHERE p.id = COALESCE(NEW.payment_id, OLD.payment_id);

  SELECT d.total_minor, d.currency_code, d.contact_id, d.status,
         COALESCE((SELECT SUM(amount_minor) FROM purchase_allocations WHERE document_id = d.id), 0) AS allocated
    INTO v_document
    FROM purchase_documents d WHERE d.id = COALESCE(NEW.document_id, OLD.document_id);

  IF v_payment.contact_id IS NOT NULL AND v_document.contact_id IS NOT NULL THEN
    IF v_payment.contact_id IS DISTINCT FROM v_document.contact_id THEN
      RAISE EXCEPTION 'A payment cannot be allocated to another vendor bill'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_payment.currency_code IS DISTINCT FROM v_document.currency_code THEN
      RAISE EXCEPTION 'Payment currency % does not match bill currency %',
        v_payment.currency_code, v_document.currency_code
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_document.status NOT IN ('open', 'paid') THEN
      RAISE EXCEPTION 'Bill is % and cannot be paid; approve and post it first', v_document.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF v_payment.amount_minor IS NOT NULL AND v_payment.allocated > v_payment.amount_minor THEN
    RAISE EXCEPTION 'Allocations of % exceed the payment amount of %',
      v_payment.allocated, v_payment.amount_minor USING ERRCODE = 'check_violation';
  END IF;

  IF v_document.total_minor IS NOT NULL AND v_document.allocated > v_document.total_minor THEN
    RAISE EXCEPTION 'Allocations of % exceed the bill total of %',
      v_document.allocated, v_document.total_minor USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER purchase_allocations_within_limits
  AFTER INSERT OR UPDATE OR DELETE ON purchase_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_purchase_allocation_within_limits();

-- ---------------------------------------------------------------------
-- Bill totals and immutability
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION check_purchase_totals(p_doc_id UUID) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_doc   RECORD;
  v_lines RECORD;
BEGIN
  SELECT subtotal_minor, tax_total_minor, total_minor, status
    INTO v_doc FROM purchase_documents WHERE id = p_doc_id;
  IF NOT FOUND OR v_doc.status = 'draft' THEN RETURN; END IF;

  SELECT COALESCE(SUM(line_total_minor), 0) AS subtotal,
         COALESCE(SUM(tax_amount_minor), 0)  AS tax,
         count(*)                            AS lines
    INTO v_lines FROM purchase_document_lines WHERE document_id = p_doc_id;

  IF v_lines.lines = 0 THEN
    RAISE EXCEPTION 'Bill % has no lines', p_doc_id USING ERRCODE = 'check_violation';
  END IF;

  IF v_doc.subtotal_minor <> v_lines.subtotal
     OR v_doc.tax_total_minor <> v_lines.tax
     OR v_doc.total_minor <> v_lines.subtotal + v_lines.tax THEN
    RAISE EXCEPTION 'Bill % totals do not match its lines', p_doc_id
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION assert_purchase_totals_header() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM check_purchase_totals(NEW.id);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION assert_purchase_totals_line() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM check_purchase_totals(COALESCE(NEW.document_id, OLD.document_id));
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER purchase_documents_totals_match
  AFTER INSERT OR UPDATE ON purchase_documents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_purchase_totals_header();

CREATE CONSTRAINT TRIGGER purchase_document_lines_totals_match
  AFTER INSERT OR UPDATE OR DELETE ON purchase_document_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_purchase_totals_line();

/* Once a bill is posted it is immutable, like every other posted document. */
CREATE OR REPLACE FUNCTION assert_posted_bill_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed purchase_documents%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('draft', 'pending_approval') THEN
      RAISE EXCEPTION 'Bill % is % and cannot be deleted; issue a debit note instead',
        COALESCE(OLD.doc_ref, OLD.id::text), OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('draft', 'pending_approval', 'approved') THEN RETURN NEW; END IF;

  allowed := OLD;
  allowed.status := NEW.status;
  allowed.void_reason := NEW.void_reason;
  allowed.notes := NEW.notes;
  allowed.match_status := NEW.match_status;
  allowed.match_notes := NEW.match_notes;
  allowed.updated_at := NEW.updated_at;

  IF NEW IS DISTINCT FROM allowed THEN
    RAISE EXCEPTION 'Bill % is posted; correct it with a debit note',
      COALESCE(OLD.doc_ref, OLD.id::text) USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER purchase_documents_01_immutable
  BEFORE UPDATE OR DELETE ON purchase_documents
  FOR EACH ROW EXECUTE FUNCTION assert_posted_bill_immutable();

-- ---------------------------------------------------------------------
-- Three-way match support
-- ---------------------------------------------------------------------

/*
 * Ordered, received and billed quantities per purchase order line.
 * The match compares these three and the unit price; the tolerance and the
 * verdict live in the domain layer so they are unit-testable.
 */
CREATE OR REPLACE VIEW purchase_order_line_progress AS
SELECT ol.id AS order_line_id,
       ol.tenant_id,
       ol.order_id,
       ol.line_no,
       ol.description,
       ol.quantity        AS quantity_ordered,
       ol.unit_price_minor AS unit_price_ordered,
       COALESCE(grn.quantity_received, 0) AS quantity_received,
       COALESCE(bill.quantity_billed, 0)  AS quantity_billed,
       bill.unit_price_billed
  FROM purchase_order_lines ol
  LEFT JOIN (
    SELECT order_line_id, SUM(quantity_received) AS quantity_received
      FROM goods_receipt_lines WHERE order_line_id IS NOT NULL GROUP BY order_line_id
  ) grn ON grn.order_line_id = ol.id
  LEFT JOIN (
    SELECT l.order_line_id,
           SUM(l.quantity) AS quantity_billed,
           MAX(l.unit_price_minor) AS unit_price_billed
      FROM purchase_document_lines l
      JOIN purchase_documents d ON d.id = l.document_id
     WHERE l.order_line_id IS NOT NULL AND d.status <> 'void'
     GROUP BY l.order_line_id
  ) bill ON bill.order_line_id = ol.id;

-- ---------------------------------------------------------------------
-- RLS, audit, permissions
-- ---------------------------------------------------------------------

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'purchase_orders', 'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines',
    'purchase_documents', 'purchase_document_lines', 'bill_approvals', 'purchase_allocations'
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
  END LOOP;

  FOREACH t IN ARRAY ARRAY[
    'purchase_orders', 'purchase_order_lines', 'goods_receipts',
    'purchase_documents', 'purchase_document_lines'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %1$I_set_updated_at BEFORE UPDATE ON %1$I
                    FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO acct_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO acct_auditor;

INSERT INTO permissions (code, description, module) VALUES
  ('ap.po.read',    'View purchase orders',      'ap'),
  ('ap.po.write',   'Create purchase orders',    'ap'),
  ('ap.grn.write',  'Record goods receipts',     'ap'),
  ('ap.payment.read', 'View vendor payments',    'ap')
ON CONFLICT (code) DO NOTHING;
