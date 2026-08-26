-- =====================================================================
-- M12 — Attachments: documents stored in object storage, not in the row.
-- =====================================================================

CREATE TYPE scan_status AS ENUM ('pending', 'clean', 'infected', 'skipped');

/*
 * The bytes live in object storage; this table is the record of what exists,
 * who put it there and what it belongs to. Storing the object key rather than a
 * URL means the bucket can move without rewriting history, and every read goes
 * through a freshly signed URL rather than a link that never expires.
 */
CREATE TABLE attachments (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  entity_type    TEXT NOT NULL,
  entity_id      UUID NOT NULL,
  object_key     TEXT NOT NULL,
  file_name      TEXT NOT NULL,
  content_type   TEXT NOT NULL,
  size_bytes     BIGINT NOT NULL CHECK (size_bytes > 0),
  checksum_sha256 TEXT,
  scan_status    scan_status NOT NULL DEFAULT 'pending',
  scan_message   TEXT,
  uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by    UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, object_key)
);

CREATE INDEX attachments_entity_idx ON attachments (tenant_id, entity_type, entity_id);

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY attachments_tenant_isolation ON attachments
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE TRIGGER attachments_audit AFTER INSERT OR UPDATE OR DELETE ON attachments
  FOR EACH ROW EXECUTE FUNCTION write_audit_log();
CREATE TRIGGER attachments_set_updated_at BEFORE UPDATE ON attachments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO acct_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO acct_auditor;

INSERT INTO permissions (code, description, module) VALUES
  ('attachment.read',  'Read attachments', 'admin'),
  ('attachment.write', 'Upload and remove attachments', 'admin')
ON CONFLICT (code) DO NOTHING;
