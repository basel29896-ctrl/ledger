-- =====================================================================
-- M7 — Tax engine, Jordan localisation and e-invoicing clearance.
-- =====================================================================

CREATE TYPE tax_treatment AS ENUM ('standard', 'zero_rated', 'exempt');
CREATE TYPE clearance_status AS ENUM ('not_submitted', 'pending', 'cleared', 'rejected', 'failed');

ALTER TABLE tax_codes
  ADD COLUMN treatment      tax_treatment NOT NULL DEFAULT 'standard',
  ADD COLUMN is_withholding BOOLEAN NOT NULL DEFAULT FALSE,
  -- Codes this tax is charged on top of, e.g. GST on value + Special Sales Tax.
  ADD COLUMN compound_on    TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN jurisdiction   TEXT NOT NULL DEFAULT 'JO',
  ADD COLUMN sort_order     INTEGER NOT NULL DEFAULT 100;

-- A withholding tax is deducted from a payment, never added to a sale.
ALTER TABLE tax_codes
  ADD CONSTRAINT tax_codes_withholding_is_purchase
  CHECK (NOT is_withholding OR kind IN ('purchase', 'both'));

/*
 * E-invoicing clearance.
 *
 * Until the national system clears it, an invoice is not a valid tax document.
 * That fact lives on the invoice itself so every reader — PDF renderer, tax
 * return, API consumer — sees the same answer.
 */
ALTER TABLE sales_documents
  ADD COLUMN clearance_status   clearance_status NOT NULL DEFAULT 'not_submitted',
  ADD COLUMN clearance_uuid     TEXT,
  ADD COLUMN clearance_qr       TEXT,
  ADD COLUMN clearance_message  TEXT,
  ADD COLUMN clearance_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN cleared_at         TIMESTAMPTZ,
  ADD COLUMN last_submitted_at  TIMESTAMPTZ;

CREATE INDEX sales_documents_clearance_idx
  ON sales_documents (tenant_id, clearance_status)
  WHERE clearance_status IN ('not_submitted', 'pending', 'failed');

/* A cleared document keeps its clearance: it cannot be silently re-cleared. */
CREATE OR REPLACE FUNCTION assert_clearance_not_overwritten() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.clearance_status = 'cleared'
     AND (NEW.clearance_uuid IS DISTINCT FROM OLD.clearance_uuid
          OR NEW.clearance_status <> 'cleared') THEN
    RAISE EXCEPTION
      'Document % is already cleared (%); clearance cannot be changed',
      COALESCE(OLD.doc_ref, OLD.id::text), OLD.clearance_uuid
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER sales_documents_clearance_immutable
  BEFORE UPDATE ON sales_documents
  FOR EACH ROW EXECUTE FUNCTION assert_clearance_not_overwritten();

-- The immutability trigger must also let the clearance fields move.
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
  -- Clearance is written by the e-invoicing adapter after posting.
  allowed.clearance_status := NEW.clearance_status;
  allowed.clearance_uuid := NEW.clearance_uuid;
  allowed.clearance_qr := NEW.clearance_qr;
  allowed.clearance_message := NEW.clearance_message;
  allowed.clearance_attempts := NEW.clearance_attempts;
  allowed.cleared_at := NEW.cleared_at;
  allowed.last_submitted_at := NEW.last_submitted_at;

  IF NEW IS DISTINCT FROM allowed THEN
    RAISE EXCEPTION 'Document % is posted; correct it with a credit note',
      COALESCE(OLD.doc_ref, OLD.id::text)
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

-- Filed tax returns, kept so a period can be reported once and referred to later.
CREATE TABLE tax_returns (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  from_date      DATE NOT NULL,
  to_date        DATE NOT NULL,
  currency_code  CHAR(3) NOT NULL REFERENCES currencies(code),
  output_tax_minor      BIGINT NOT NULL,
  input_tax_minor       BIGINT NOT NULL,
  net_payable_minor     BIGINT NOT NULL,
  detail         JSONB NOT NULL,
  filed_at       TIMESTAMPTZ,
  filed_by       UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID REFERENCES users(id),
  CONSTRAINT tax_returns_dates CHECK (to_date >= from_date),
  UNIQUE (tenant_id, from_date, to_date)
);

ALTER TABLE tax_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_returns FORCE ROW LEVEL SECURITY;
CREATE POLICY tax_returns_tenant_isolation ON tax_returns
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE TRIGGER tax_returns_audit AFTER INSERT OR UPDATE OR DELETE ON tax_returns
  FOR EACH ROW EXECUTE FUNCTION write_audit_log();
CREATE TRIGGER tax_returns_set_updated_at BEFORE UPDATE ON tax_returns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO acct_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO acct_auditor;

INSERT INTO permissions (code, description, module) VALUES
  ('tax.einvoice.submit', 'Submit invoices for e-invoicing clearance', 'tax')
ON CONFLICT (code) DO NOTHING;
