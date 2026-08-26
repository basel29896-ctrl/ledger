-- =====================================================================
-- M4 — Accounts Receivable.
--
-- Invoices and receipts are documents; the ledger entries they produce are
-- still ordinary journal entries subject to every invariant from M1. A
-- document never writes a balance directly.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Contacts (customers and vendors share one table)
-- ---------------------------------------------------------------------

CREATE TABLE contacts (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  code              TEXT NOT NULL,
  name              TEXT NOT NULL,
  name_ar           TEXT,
  is_customer       BOOLEAN NOT NULL DEFAULT FALSE,
  is_vendor         BOOLEAN NOT NULL DEFAULT FALSE,
  tax_number        TEXT,
  email             TEXT,
  phone             TEXT,
  billing_address   TEXT,
  shipping_address  TEXT,
  -- Net terms in days; 0 means due on receipt.
  payment_terms_days SMALLINT NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
  credit_limit_minor BIGINT CHECK (credit_limit_minor IS NULL OR credit_limit_minor >= 0),
  default_currency  CHAR(3) REFERENCES currencies(code),
  -- Sub-ledger control accounts; NULL falls back to the tenant defaults.
  receivable_account_id UUID REFERENCES accounts(id),
  payable_account_id    UUID REFERENCES accounts(id),
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES users(id),
  UNIQUE (tenant_id, code),
  CONSTRAINT contacts_is_something CHECK (is_customer OR is_vendor)
);

CREATE INDEX contacts_tenant_customer_idx ON contacts (tenant_id, is_customer) WHERE is_customer;
CREATE INDEX contacts_tenant_vendor_idx ON contacts (tenant_id, is_vendor) WHERE is_vendor;

-- Journal lines may now name a contact, so AR/AP sub-ledgers reconcile to the GL.
ALTER TABLE journal_lines
  ADD CONSTRAINT journal_lines_contact_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id);

-- ---------------------------------------------------------------------
-- Tax codes (the engine and the Jordan set arrive in M7)
-- ---------------------------------------------------------------------

CREATE TYPE tax_kind AS ENUM ('sales', 'purchase', 'both');

CREATE TABLE tax_codes (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  code              TEXT NOT NULL,
  name              TEXT NOT NULL,
  name_ar           TEXT,
  kind              tax_kind NOT NULL DEFAULT 'both',
  -- Percent, e.g. 16.0000 for Jordan general sales tax.
  rate_percent      NUMERIC(9, 4) NOT NULL CHECK (rate_percent >= 0),
  is_recoverable    BOOLEAN NOT NULL DEFAULT TRUE,
  output_account_id UUID REFERENCES accounts(id),
  input_account_id  UUID REFERENCES accounts(id),
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

ALTER TABLE journal_lines
  ADD CONSTRAINT journal_lines_tax_code_fkey FOREIGN KEY (tax_code_id) REFERENCES tax_codes(id);

-- ---------------------------------------------------------------------
-- Sales documents
-- ---------------------------------------------------------------------

CREATE TYPE sales_doc_type AS ENUM ('invoice', 'credit_note');
CREATE TYPE sales_doc_status AS ENUM ('draft', 'open', 'paid', 'void');

CREATE TABLE sales_documents (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  doc_type          sales_doc_type NOT NULL DEFAULT 'invoice',
  doc_no            BIGINT,
  doc_ref           TEXT,
  contact_id        UUID NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  issue_date        DATE NOT NULL,
  due_date          DATE NOT NULL,
  currency_code     CHAR(3) NOT NULL REFERENCES currencies(code),
  fx_rate           NUMERIC(20, 10) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
  -- Totals in document currency, minor units. Maintained from the lines.
  subtotal_minor    BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  tax_total_minor   BIGINT NOT NULL DEFAULT 0 CHECK (tax_total_minor >= 0),
  total_minor       BIGINT NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  status            sales_doc_status NOT NULL DEFAULT 'draft',
  reference         TEXT,
  notes             TEXT,
  terms             TEXT,
  -- The journal entry this document posted. NULL while it is a draft.
  journal_entry_id  UUID REFERENCES journal_entries(id),
  -- A credit note may be linked to the invoice it credits.
  credits_document_id UUID REFERENCES sales_documents(id),
  void_reason       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES users(id),
  CONSTRAINT sales_documents_dates CHECK (due_date >= issue_date),
  CONSTRAINT sales_documents_posted_has_number
    CHECK (status = 'draft' OR (doc_no IS NOT NULL AND journal_entry_id IS NOT NULL))
);

CREATE UNIQUE INDEX sales_documents_no_unique
  ON sales_documents (tenant_id, doc_type, doc_no) WHERE doc_no IS NOT NULL;
CREATE INDEX sales_documents_contact_idx ON sales_documents (tenant_id, contact_id, status);
CREATE INDEX sales_documents_due_idx ON sales_documents (tenant_id, due_date) WHERE status = 'open';

CREATE TABLE sales_document_lines (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  document_id       UUID NOT NULL REFERENCES sales_documents(id) ON DELETE CASCADE,
  line_no           INTEGER NOT NULL CHECK (line_no > 0),
  description       TEXT NOT NULL,
  -- Quantity carries four decimals so part-units do not round at entry.
  quantity          NUMERIC(18, 4) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_minor  BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor  BIGINT NOT NULL CHECK (line_total_minor >= 0),
  tax_code_id       UUID REFERENCES tax_codes(id),
  tax_amount_minor  BIGINT NOT NULL DEFAULT 0 CHECK (tax_amount_minor >= 0),
  revenue_account_id UUID NOT NULL REFERENCES accounts(id),
  cost_center_id    UUID,
  project_id        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, line_no)
);

CREATE INDEX sales_document_lines_doc_idx ON sales_document_lines (document_id);

-- ---------------------------------------------------------------------
-- Customer receipts and their allocation
-- ---------------------------------------------------------------------

CREATE TYPE payment_direction AS ENUM ('received', 'paid');
CREATE TYPE payment_status AS ENUM ('draft', 'posted', 'void');

CREATE TABLE payments (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  direction         payment_direction NOT NULL,
  payment_no        BIGINT,
  payment_ref       TEXT,
  contact_id        UUID NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  payment_date      DATE NOT NULL,
  currency_code     CHAR(3) NOT NULL REFERENCES currencies(code),
  fx_rate           NUMERIC(20, 10) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
  amount_minor      BIGINT NOT NULL CHECK (amount_minor > 0),
  bank_account_id   UUID NOT NULL REFERENCES accounts(id),
  method            TEXT NOT NULL DEFAULT 'bank_transfer',
  reference         TEXT,
  memo              TEXT,
  status            payment_status NOT NULL DEFAULT 'draft',
  journal_entry_id  UUID REFERENCES journal_entries(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES users(id)
);

CREATE UNIQUE INDEX payments_no_unique
  ON payments (tenant_id, direction, payment_no) WHERE payment_no IS NOT NULL;
CREATE INDEX payments_contact_idx ON payments (tenant_id, contact_id, status);

/*
 * Allocation is the link between money received and the invoice it settles.
 * It carries no GL effect of its own: the receipt already debited the bank and
 * credited receivables. Allocation only says which invoice stopped being owed.
 */
CREATE TABLE payment_allocations (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  payment_id        UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  document_id       UUID NOT NULL REFERENCES sales_documents(id) ON DELETE RESTRICT,
  amount_minor      BIGINT NOT NULL CHECK (amount_minor > 0),
  allocated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  allocated_by      UUID REFERENCES users(id),
  UNIQUE (payment_id, document_id)
);

CREATE INDEX payment_allocations_document_idx ON payment_allocations (document_id);

-- ---------------------------------------------------------------------
-- Outstanding balances, derived from documents and their allocations
-- ---------------------------------------------------------------------

CREATE OR REPLACE VIEW sales_document_balances AS
SELECT d.id AS document_id,
       d.tenant_id,
       d.contact_id,
       d.doc_type,
       d.doc_ref,
       d.issue_date,
       d.due_date,
       d.currency_code,
       d.status,
       d.total_minor,
       COALESCE(a.allocated_minor, 0)::bigint AS allocated_minor,
       (d.total_minor - COALESCE(a.allocated_minor, 0))::bigint AS outstanding_minor
  FROM sales_documents d
  LEFT JOIN (
    SELECT document_id, SUM(amount_minor) AS allocated_minor
      FROM payment_allocations GROUP BY document_id
  ) a ON a.document_id = d.id
 WHERE d.status <> 'void';

CREATE OR REPLACE VIEW payment_balances AS
SELECT p.id AS payment_id,
       p.tenant_id,
       p.contact_id,
       p.direction,
       p.payment_date,
       p.currency_code,
       p.amount_minor,
       COALESCE(a.allocated_minor, 0)::bigint AS allocated_minor,
       (p.amount_minor - COALESCE(a.allocated_minor, 0))::bigint AS unapplied_minor
  FROM payments p
  LEFT JOIN (
    SELECT payment_id, SUM(amount_minor) AS allocated_minor
      FROM payment_allocations GROUP BY payment_id
  ) a ON a.payment_id = p.id
 WHERE p.status <> 'void';

-- ---------------------------------------------------------------------
-- Allocation invariants
-- ---------------------------------------------------------------------

/*
 * An allocation may never exceed what the payment still holds, nor what the
 * document still owes. Both sides are checked at COMMIT so a batch receipt can
 * write several allocations in any order within one transaction.
 */
CREATE OR REPLACE FUNCTION assert_allocation_within_limits() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_payment_id  UUID;
  v_document_id UUID;
  v_payment     RECORD;
  v_document    RECORD;
BEGIN
  v_payment_id := COALESCE(NEW.payment_id, OLD.payment_id);
  v_document_id := COALESCE(NEW.document_id, OLD.document_id);

  SELECT p.amount_minor, p.currency_code, p.contact_id, p.status,
         COALESCE((SELECT SUM(amount_minor) FROM payment_allocations WHERE payment_id = p.id), 0) AS allocated
    INTO v_payment
    FROM payments p WHERE p.id = v_payment_id;

  SELECT d.total_minor, d.currency_code, d.contact_id, d.status,
         COALESCE((SELECT SUM(amount_minor) FROM payment_allocations WHERE document_id = d.id), 0) AS allocated
    INTO v_document
    FROM sales_documents d WHERE d.id = v_document_id;

  -- Identity first: allocating to the wrong contact or currency is a different
  -- mistake from allocating too much, and the message should say which.
  IF FOUND AND v_payment.contact_id IS NOT NULL THEN
    IF v_payment.contact_id IS DISTINCT FROM v_document.contact_id THEN
      RAISE EXCEPTION 'A payment cannot be allocated to another contact document'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_payment.currency_code IS DISTINCT FROM v_document.currency_code THEN
      RAISE EXCEPTION 'Payment currency % does not match document currency %',
        v_payment.currency_code, v_document.currency_code
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_document.status = 'draft' THEN
      RAISE EXCEPTION 'A draft document cannot be paid; post it first'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF v_payment.amount_minor IS NOT NULL AND v_payment.allocated > v_payment.amount_minor THEN
    RAISE EXCEPTION
      'Allocations of % exceed the payment amount of %', v_payment.allocated, v_payment.amount_minor
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_document.total_minor IS NOT NULL AND v_document.allocated > v_document.total_minor THEN
    RAISE EXCEPTION
      'Allocations of % exceed the document total of %', v_document.allocated, v_document.total_minor
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER payment_allocations_within_limits
  AFTER INSERT OR UPDATE OR DELETE ON payment_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_allocation_within_limits();

/*
 * Document totals must equal the sum of their lines, checked at COMMIT.
 *
 * Two thin trigger functions rather than one: plpgsql resolves every NEW/OLD
 * field reference in the body regardless of branch, so a single function
 * naming both `NEW.id` and `NEW.document_id` fails on whichever table lacks
 * the other column.
 */
CREATE OR REPLACE FUNCTION check_document_totals(p_doc_id UUID) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_doc   RECORD;
  v_lines RECORD;
BEGIN
  SELECT subtotal_minor, tax_total_minor, total_minor, status
    INTO v_doc FROM sales_documents WHERE id = p_doc_id;
  IF NOT FOUND OR v_doc.status = 'draft' THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM(line_total_minor), 0) AS subtotal,
         COALESCE(SUM(tax_amount_minor), 0)  AS tax,
         count(*)                            AS lines
    INTO v_lines FROM sales_document_lines WHERE document_id = p_doc_id;

  IF v_lines.lines = 0 THEN
    RAISE EXCEPTION 'Document % has no lines', p_doc_id USING ERRCODE = 'check_violation';
  END IF;

  IF v_doc.subtotal_minor <> v_lines.subtotal
     OR v_doc.tax_total_minor <> v_lines.tax
     OR v_doc.total_minor <> v_lines.subtotal + v_lines.tax THEN
    RAISE EXCEPTION
      'Document % totals (net %, tax %, gross %) do not match its lines (net %, tax %, gross %)',
      p_doc_id, v_doc.subtotal_minor, v_doc.tax_total_minor, v_doc.total_minor,
      v_lines.subtotal, v_lines.tax, v_lines.subtotal + v_lines.tax
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION assert_document_totals_header() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM check_document_totals(NEW.id);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION assert_document_totals_line() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM check_document_totals(COALESCE(NEW.document_id, OLD.document_id));
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER sales_documents_totals_match
  AFTER INSERT OR UPDATE ON sales_documents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_document_totals_header();

CREATE CONSTRAINT TRIGGER sales_document_lines_totals_match
  AFTER INSERT OR UPDATE OR DELETE ON sales_document_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_document_totals_line();

/* A posted document is immutable, exactly like the journal entry it produced. */
CREATE OR REPLACE FUNCTION assert_posted_document_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed sales_documents%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Document % is % and cannot be deleted; issue a credit note instead',
        COALESCE(OLD.doc_ref, OLD.id::text), OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'draft' THEN RETURN NEW; END IF;

  allowed := OLD;
  allowed.status := NEW.status;
  allowed.void_reason := NEW.void_reason;
  allowed.notes := NEW.notes;
  allowed.updated_at := NEW.updated_at;

  IF NEW IS DISTINCT FROM allowed THEN
    RAISE EXCEPTION 'Document % is posted; correct it with a credit note',
      COALESCE(OLD.doc_ref, OLD.id::text)
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER sales_documents_01_immutable
  BEFORE UPDATE OR DELETE ON sales_documents
  FOR EACH ROW EXECUTE FUNCTION assert_posted_document_immutable();

CREATE OR REPLACE FUNCTION assert_posted_document_line_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status sales_doc_status;
BEGIN
  SELECT status INTO v_status FROM sales_documents
   WHERE id = COALESCE(NEW.document_id, OLD.document_id);
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'Lines of a posted document cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER sales_document_lines_01_immutable
  BEFORE UPDATE OR DELETE ON sales_document_lines
  FOR EACH ROW EXECUTE FUNCTION assert_posted_document_line_immutable();

-- ---------------------------------------------------------------------
-- Row-level security and audit for the new tables
-- ---------------------------------------------------------------------

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'contacts', 'tax_codes', 'sales_documents', 'sales_document_lines',
    'payments', 'payment_allocations'
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
    -- payment_allocations is written once and never edited, so it has no updated_at.
    IF t <> 'payment_allocations' THEN
      EXECUTE format('CREATE TRIGGER %1$I_set_updated_at BEFORE UPDATE ON %1$I
                      FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END IF;
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO acct_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO acct_auditor;

INSERT INTO permissions (code, description, module) VALUES
  ('ar.creditnote.write', 'Issue credit notes', 'ar'),
  ('ar.payment.read',     'View customer receipts', 'ar')
ON CONFLICT (code) DO NOTHING;
