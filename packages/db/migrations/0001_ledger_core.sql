-- =====================================================================
-- M1 — Ledger core.
--
-- Everything in Section 2 of the specification that can be enforced by the
-- database is enforced here, not in application code. The API, background
-- workers, migrations and a human with psql all write through these rules.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------

-- UUID v7: time-ordered, so primary keys cluster by insertion time and index
-- locality on a append-heavy ledger stays good. Postgres 16 has no built-in.
CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  unix_ts_ms BYTEA;
  uuid_bytes BYTEA;
BEGIN
  unix_ts_ms := substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3);
  uuid_bytes := unix_ts_ms || gen_random_bytes(10);
  -- byte 6: high nibble = version 7
  uuid_bytes := set_byte(uuid_bytes, 6, (get_byte(uuid_bytes, 6) & 15) | 112);
  -- byte 8: high two bits = RFC 4122 variant (10xx)
  uuid_bytes := set_byte(uuid_bytes, 8, (get_byte(uuid_bytes, 8) & 63) | 128);
  RETURN encode(uuid_bytes, 'hex')::uuid;
END $$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- Tenancy (minimal in M1; roles, permissions and RLS arrive in M2)
-- ---------------------------------------------------------------------

CREATE TABLE tenants (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  base_currency CHAR(3) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  email        TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

-- ---------------------------------------------------------------------
-- Currencies and rates
-- ---------------------------------------------------------------------

CREATE TABLE currencies (
  code                CHAR(3) PRIMARY KEY,
  name                TEXT NOT NULL,
  symbol              TEXT,
  -- 2 for USD/EUR, 3 for JOD/KWD/BHD/TND, 0 for JPY. Never assume 2.
  minor_unit_exponent SMALLINT NOT NULL CHECK (minor_unit_exponent BETWEEN 0 AND 4),
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tenants
  ADD CONSTRAINT tenants_base_currency_fkey FOREIGN KEY (base_currency) REFERENCES currencies(code);

CREATE TABLE exchange_rates (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  from_currency CHAR(3) NOT NULL REFERENCES currencies(code),
  to_currency   CHAR(3) NOT NULL REFERENCES currencies(code),
  rate          NUMERIC(20, 10) NOT NULL CHECK (rate > 0),
  rate_date     DATE NOT NULL,
  source        TEXT NOT NULL DEFAULT 'manual',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID REFERENCES users(id),
  CONSTRAINT exchange_rates_distinct_currencies CHECK (from_currency <> to_currency),
  UNIQUE (tenant_id, from_currency, to_currency, rate_date)
);

-- ---------------------------------------------------------------------
-- Fiscal calendar
-- ---------------------------------------------------------------------

CREATE TYPE fiscal_status AS ENUM ('open', 'soft_closed', 'closed');

CREATE TABLE fiscal_years (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name       TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date   DATE NOT NULL,
  status     fiscal_status NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id),
  CONSTRAINT fiscal_years_dates CHECK (end_date > start_date),
  UNIQUE (tenant_id, name)
);

CREATE TABLE fiscal_periods (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  fiscal_year_id UUID NOT NULL REFERENCES fiscal_years(id) ON DELETE RESTRICT,
  period_no      SMALLINT NOT NULL CHECK (period_no BETWEEN 1 AND 13),
  start_date     DATE NOT NULL,
  end_date       DATE NOT NULL,
  status         fiscal_status NOT NULL DEFAULT 'open',
  closed_at      TIMESTAMPTZ,
  closed_by      UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID REFERENCES users(id),
  CONSTRAINT fiscal_periods_dates CHECK (end_date >= start_date),
  UNIQUE (tenant_id, fiscal_year_id, period_no)
);

-- One period per tenant per day: an entry date must resolve to exactly one period.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE fiscal_periods
  ADD CONSTRAINT fiscal_periods_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  );

CREATE INDEX fiscal_periods_lookup_idx ON fiscal_periods (tenant_id, start_date, end_date);

-- ---------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------

CREATE TYPE account_type AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');
CREATE TYPE normal_balance AS ENUM ('debit', 'credit');

CREATE TABLE accounts (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  code              TEXT NOT NULL,
  name              TEXT NOT NULL,
  name_ar           TEXT,
  type              account_type NOT NULL,
  subtype           TEXT,
  normal_balance    normal_balance NOT NULL,
  parent_account_id UUID REFERENCES accounts(id) ON DELETE RESTRICT,
  -- NULL means the account accepts any transaction currency.
  currency_code     CHAR(3) REFERENCES currencies(code),
  is_bank           BOOLEAN NOT NULL DEFAULT FALSE,
  is_control_account BOOLEAN NOT NULL DEFAULT FALSE,
  -- Parents summarise their children and must never carry postings themselves.
  is_postable       BOOLEAN NOT NULL DEFAULT TRUE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES users(id),
  UNIQUE (tenant_id, code),
  CONSTRAINT accounts_not_own_parent CHECK (id <> parent_account_id)
);

CREATE INDEX accounts_tenant_type_idx ON accounts (tenant_id, type);
CREATE INDEX accounts_parent_idx ON accounts (parent_account_id);

-- The normal balance follows from the account type; a mismatch would invert
-- every report that account appears in.
CREATE OR REPLACE FUNCTION assert_account_normal_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected normal_balance;
BEGIN
  expected := CASE NEW.type
                WHEN 'asset' THEN 'debit'
                WHEN 'expense' THEN 'debit'
                ELSE 'credit'
              END::normal_balance;
  IF NEW.normal_balance <> expected THEN
    RAISE EXCEPTION 'Account % of type % must have normal balance %, got %',
      NEW.code, NEW.type, expected, NEW.normal_balance
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.parent_account_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM accounts p
                WHERE p.id = NEW.parent_account_id AND p.tenant_id <> NEW.tenant_id) THEN
      RAISE EXCEPTION 'Parent account must belong to the same tenant'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER accounts_assert_normal_balance
  BEFORE INSERT OR UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION assert_account_normal_balance();

-- A parent account must stop being postable once it has children.
CREATE OR REPLACE FUNCTION assert_parent_not_postable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_account_id IS NOT NULL THEN
    UPDATE accounts SET is_postable = FALSE, updated_at = now()
     WHERE id = NEW.parent_account_id AND is_postable;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER accounts_demote_parent
  AFTER INSERT OR UPDATE OF parent_account_id ON accounts
  FOR EACH ROW EXECUTE FUNCTION assert_parent_not_postable();

-- ---------------------------------------------------------------------
-- Gapless document numbering
-- ---------------------------------------------------------------------

CREATE TABLE number_sequences (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  doc_type   TEXT NOT NULL,
  -- Scope within which the sequence is gapless, e.g. the fiscal year id.
  scope_key  TEXT NOT NULL DEFAULT '',
  prefix     TEXT NOT NULL DEFAULT '',
  next_value BIGINT NOT NULL DEFAULT 1 CHECK (next_value > 0),
  padding    SMALLINT NOT NULL DEFAULT 6 CHECK (padding BETWEEN 0 AND 12),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, doc_type, scope_key)
);

/*
 * Allocate the next number in a sequence.
 *
 * The row is locked with UPDATE, so concurrent posters serialise here and the
 * sequence has no gaps. A Postgres SEQUENCE would be faster but loses numbers
 * on rollback, and a tax authority does not accept "we lost invoice 42".
 */
CREATE OR REPLACE FUNCTION allocate_document_number(
  p_tenant   UUID,
  p_doc_type TEXT,
  p_scope    TEXT
) RETURNS TABLE (allocated_value BIGINT, formatted TEXT)
LANGUAGE plpgsql AS $$
DECLARE
  seq number_sequences%ROWTYPE;
BEGIN
  SELECT * INTO seq FROM number_sequences
   WHERE tenant_id = p_tenant AND doc_type = p_doc_type AND scope_key = p_scope
   FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO number_sequences (tenant_id, doc_type, scope_key)
    VALUES (p_tenant, p_doc_type, p_scope)
    ON CONFLICT (tenant_id, doc_type, scope_key) DO NOTHING;

    SELECT * INTO seq FROM number_sequences
     WHERE tenant_id = p_tenant AND doc_type = p_doc_type AND scope_key = p_scope
     FOR UPDATE;
  END IF;

  UPDATE number_sequences SET next_value = seq.next_value + 1, updated_at = now()
   WHERE id = seq.id;

  allocated_value := seq.next_value;
  formatted := seq.prefix || lpad(seq.next_value::text, seq.padding, '0');
  RETURN NEXT;
END $$;

-- ---------------------------------------------------------------------
-- Journal
-- ---------------------------------------------------------------------

CREATE TYPE entry_status AS ENUM ('draft', 'posted', 'reversed', 'void');
CREATE TYPE entry_side AS ENUM ('debit', 'credit');
CREATE TYPE source_module AS ENUM (
  'manual', 'ar', 'ap', 'bank', 'inventory', 'payroll', 'fx', 'depreciation', 'opening', 'closing'
);

CREATE TABLE journal_entries (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- Allocated at posting time, gapless per tenant per fiscal year.
  entry_no            BIGINT,
  entry_ref           TEXT,
  entry_date          DATE NOT NULL,
  period_id           UUID NOT NULL REFERENCES fiscal_periods(id) ON DELETE RESTRICT,
  fiscal_year_id      UUID NOT NULL REFERENCES fiscal_years(id) ON DELETE RESTRICT,
  status              entry_status NOT NULL DEFAULT 'draft',
  source_module       source_module NOT NULL DEFAULT 'manual',
  source_document_id  UUID,
  -- Idempotency: (source_system, external_id) is unique per tenant.
  source_system       TEXT,
  external_id         TEXT,
  memo                TEXT,
  base_currency       CHAR(3) NOT NULL REFERENCES currencies(code),
  posted_at           TIMESTAMPTZ,
  posted_by           UUID REFERENCES users(id),
  reverses_entry_id   UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,
  reversed_by_entry_id UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,
  reversal_reason     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          UUID REFERENCES users(id),
  CONSTRAINT journal_entries_posted_has_number
    CHECK (status = 'draft' OR (entry_no IS NOT NULL AND posted_at IS NOT NULL)),
  CONSTRAINT journal_entries_not_self_reversing
    CHECK (id <> reverses_entry_id AND id <> reversed_by_entry_id)
);

CREATE UNIQUE INDEX journal_entries_no_unique
  ON journal_entries (tenant_id, fiscal_year_id, entry_no)
  WHERE entry_no IS NOT NULL;

-- Invariant 7: a retried request must never create a second entry.
CREATE UNIQUE INDEX journal_entries_idempotency_unique
  ON journal_entries (tenant_id, source_system, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX journal_entries_period_idx ON journal_entries (tenant_id, period_id, status);
CREATE INDEX journal_entries_date_idx ON journal_entries (tenant_id, entry_date);
CREATE INDEX journal_entries_source_idx ON journal_entries (tenant_id, source_module, source_document_id);

CREATE TABLE journal_lines (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  entry_id          UUID NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  line_no           INTEGER NOT NULL CHECK (line_no > 0),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  side              entry_side NOT NULL,
  -- Invariant 4/5: never signed, always minor units of `currency_code`.
  amount_minor      BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency_code     CHAR(3) NOT NULL REFERENCES currencies(code),
  fx_rate           NUMERIC(20, 10) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
  base_amount_minor BIGINT NOT NULL CHECK (base_amount_minor >= 0),
  description       TEXT,
  -- Reporting dimensions; the referenced tables arrive with their modules.
  contact_id        UUID,
  cost_center_id    UUID,
  project_id        UUID,
  tax_code_id       UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES users(id),
  UNIQUE (entry_id, line_no)
);

CREATE INDEX journal_lines_entry_idx ON journal_lines (entry_id);
CREATE INDEX journal_lines_account_idx ON journal_lines (tenant_id, account_id);

-- ---------------------------------------------------------------------
-- Invariant 1 — every posted entry balances, per currency, at COMMIT.
--
-- Deferred so that the header and its lines can be inserted in any order
-- within one transaction; the check runs once, when the transaction ends.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry_id UUID;
  v_status   entry_status;
  v_base     CHAR(3);
  v_lines    INTEGER;
  r          RECORD;
BEGIN
  v_entry_id := COALESCE(NEW.entry_id, OLD.entry_id);

  SELECT status, base_currency INTO v_status, v_base
    FROM journal_entries WHERE id = v_entry_id;

  -- The entry may have been deleted in this transaction, or may still be a draft.
  IF NOT FOUND OR v_status = 'draft' THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_lines FROM journal_lines WHERE entry_id = v_entry_id;
  IF v_lines < 2 THEN
    RAISE EXCEPTION 'Journal entry % must have at least two lines, has %', v_entry_id, v_lines
      USING ERRCODE = 'check_violation';
  END IF;

  FOR r IN
    SELECT currency_code,
           SUM(amount_minor) FILTER (WHERE side = 'debit')  AS debits,
           SUM(amount_minor) FILTER (WHERE side = 'credit') AS credits
      FROM journal_lines WHERE entry_id = v_entry_id
     GROUP BY currency_code
  LOOP
    IF COALESCE(r.debits, 0) <> COALESCE(r.credits, 0) THEN
      RAISE EXCEPTION
        'Journal entry % is out of balance in %: debits %, credits %',
        v_entry_id, r.currency_code, COALESCE(r.debits, 0), COALESCE(r.credits, 0)
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  SELECT SUM(base_amount_minor) FILTER (WHERE side = 'debit')  AS debits,
         SUM(base_amount_minor) FILTER (WHERE side = 'credit') AS credits
    INTO r
    FROM journal_lines WHERE entry_id = v_entry_id;

  IF COALESCE(r.debits, 0) <> COALESCE(r.credits, 0) THEN
    RAISE EXCEPTION
      'Journal entry % is out of balance in base currency %: debits %, credits %',
      v_entry_id, v_base, COALESCE(r.debits, 0), COALESCE(r.credits, 0)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_lines_assert_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- Posting a header with no lines at all must fail the same way.
CREATE OR REPLACE FUNCTION assert_entry_has_balanced_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_lines INTEGER;
  r       RECORD;
BEGIN
  IF NEW.status = 'draft' THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_lines FROM journal_lines WHERE entry_id = NEW.id;
  IF v_lines < 2 THEN
    RAISE EXCEPTION 'Journal entry % must have at least two lines, has %', NEW.id, v_lines
      USING ERRCODE = 'check_violation';
  END IF;

  FOR r IN
    SELECT currency_code,
           SUM(amount_minor) FILTER (WHERE side = 'debit')  AS debits,
           SUM(amount_minor) FILTER (WHERE side = 'credit') AS credits
      FROM journal_lines WHERE entry_id = NEW.id
     GROUP BY currency_code
  LOOP
    IF COALESCE(r.debits, 0) <> COALESCE(r.credits, 0) THEN
      RAISE EXCEPTION 'Journal entry % is out of balance in %: debits %, credits %',
        NEW.id, r.currency_code, COALESCE(r.debits, 0), COALESCE(r.credits, 0)
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_entries_assert_balanced
  AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_has_balanced_lines();

-- ---------------------------------------------------------------------
-- Invariant 2 — posted entries are immutable.
--
-- The only permitted change to a posted entry is the bookkeeping that links it
-- to its reversal. Everything else, including DELETE, is refused outright.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_posted_entry_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed journal_entries%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION
        'Journal entry % is % and cannot be deleted; post a reversing entry instead', OLD.id, OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  -- Rebuild the old row, applying only the fields a reversal is allowed to set,
  -- then require that nothing else moved.
  allowed := OLD;
  allowed.status := NEW.status;
  allowed.reversed_by_entry_id := NEW.reversed_by_entry_id;
  allowed.reversal_reason := NEW.reversal_reason;
  allowed.updated_at := NEW.updated_at;

  IF NEW IS DISTINCT FROM allowed THEN
    RAISE EXCEPTION
      'Journal entry % is posted and immutable; correct it with a reversing entry', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NOT (OLD.status = 'posted' AND NEW.status IN ('posted', 'reversed')) THEN
    RAISE EXCEPTION 'Journal entry % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$;

-- Named to sort first: Postgres fires BEFORE triggers in name order, and the
-- immutability guard must reject a tampering UPDATE before any other trigger
-- reports a lesser, more confusing complaint about the tampered value.
CREATE TRIGGER journal_entries_01_immutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION assert_posted_entry_immutable();

CREATE OR REPLACE FUNCTION assert_posted_line_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status entry_status;
BEGIN
  SELECT status INTO v_status FROM journal_entries
   WHERE id = COALESCE(NEW.entry_id, OLD.entry_id);

  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION
      'Line % belongs to % journal entry % and cannot be modified or deleted',
      COALESCE(NEW.id, OLD.id), v_status, COALESCE(NEW.entry_id, OLD.entry_id)
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER journal_lines_01_immutable
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION assert_posted_line_immutable();

-- ---------------------------------------------------------------------
-- Invariants 3, 5, 6 — line integrity, period lock, gapless numbering.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_line_integrity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  acct accounts%ROWTYPE;
  ent  journal_entries%ROWTYPE;
BEGIN
  SELECT * INTO ent FROM journal_entries WHERE id = NEW.entry_id;
  IF NEW.tenant_id <> ent.tenant_id THEN
    RAISE EXCEPTION 'Line tenant % does not match entry tenant %', NEW.tenant_id, ent.tenant_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO acct FROM accounts WHERE id = NEW.account_id;
  IF acct.tenant_id <> NEW.tenant_id THEN
    RAISE EXCEPTION 'Account % belongs to another tenant', NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT acct.is_postable THEN
    RAISE EXCEPTION 'Account % is a summary account and cannot be posted to', acct.code
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT acct.is_active THEN
    RAISE EXCEPTION 'Account % is inactive', acct.code
      USING ERRCODE = 'check_violation';
  END IF;
  IF acct.currency_code IS NOT NULL AND acct.currency_code <> NEW.currency_code THEN
    RAISE EXCEPTION 'Account % only accepts %, line is %', acct.code, acct.currency_code, NEW.currency_code
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount_minor = 0 THEN
    RAISE EXCEPTION 'Line amount must be greater than zero'
      USING ERRCODE = 'check_violation';
  END IF;

  -- A line in the base currency must not claim a rate other than 1:1.
  IF NEW.currency_code = ent.base_currency
     AND (NEW.fx_rate <> 1 OR NEW.base_amount_minor <> NEW.amount_minor) THEN
    RAISE EXCEPTION
      'Base-currency line must have fx_rate 1 and equal base amount (got rate %, amount %, base %)',
      NEW.fx_rate, NEW.amount_minor, NEW.base_amount_minor
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER journal_lines_assert_integrity
  BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION assert_line_integrity();

/*
 * Invariant 6 — closed periods are locked, and invariant 5 — gapless numbering.
 *
 * Both belong in the same BEFORE trigger on the header: the period must be open
 * at the moment of posting, and the number is allocated inside that same
 * transaction so a rollback releases it.
 */
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
    IF per.status <> 'open' THEN
      RAISE EXCEPTION 'Fiscal period % is % and will not accept postings', per.period_no, per.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF fy.status <> 'open' THEN
      RAISE EXCEPTION 'Fiscal year % is % and will not accept postings', fy.name, fy.status
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

CREATE TRIGGER journal_entries_assert_period
  BEFORE INSERT OR UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION assert_postable_period();

-- Closing a period must not strand drafts that were never posted into it.
CREATE OR REPLACE FUNCTION assert_period_closable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_drafts INTEGER;
BEGIN
  IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
    SELECT count(*) INTO v_drafts FROM journal_entries
     WHERE period_id = NEW.id AND status = 'draft';
    IF v_drafts > 0 THEN
      RAISE EXCEPTION 'Period % still has % draft entries; post or void them before closing',
        NEW.period_no, v_drafts
        USING ERRCODE = 'restrict_violation';
    END IF;
    NEW.closed_at := now();
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fiscal_periods_assert_closable
  BEFORE UPDATE ON fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION assert_period_closable();

-- ---------------------------------------------------------------------
-- Invariant 3 — derived balances.
--
-- account_balances is a cache of a computation over journal_lines and can be
-- dropped and rebuilt at any time without losing information.
-- ---------------------------------------------------------------------

CREATE TABLE account_balances (
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  period_id       UUID NOT NULL REFERENCES fiscal_periods(id) ON DELETE RESTRICT,
  currency_code   CHAR(3) NOT NULL REFERENCES currencies(code),
  debit_total     BIGINT NOT NULL DEFAULT 0 CHECK (debit_total >= 0),
  credit_total    BIGINT NOT NULL DEFAULT 0 CHECK (credit_total >= 0),
  -- Signed towards the account normal balance, in base-currency minor units.
  closing_balance BIGINT NOT NULL DEFAULT 0,
  rebuilt_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, period_id, currency_code)
);

CREATE INDEX account_balances_period_idx ON account_balances (tenant_id, period_id);

/*
 * Rebuild the balance cache from journal lines. Pass NULL to rebuild every
 * tenant. This is the implementation behind `make ledger:rebuild`, and its
 * output must be byte-identical to whatever incremental maintenance produced.
 */
CREATE OR REPLACE FUNCTION ledger_rebuild_balances(p_tenant UUID DEFAULT NULL)
RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE
  v_rows BIGINT;
BEGIN
  DELETE FROM account_balances WHERE p_tenant IS NULL OR tenant_id = p_tenant;

  INSERT INTO account_balances (
    tenant_id, account_id, period_id, currency_code,
    debit_total, credit_total, closing_balance, rebuilt_at
  )
  SELECT l.tenant_id,
         l.account_id,
         e.period_id,
         l.currency_code,
         COALESCE(SUM(l.amount_minor) FILTER (WHERE l.side = 'debit'), 0),
         COALESCE(SUM(l.amount_minor) FILTER (WHERE l.side = 'credit'), 0),
         CASE a.normal_balance
           WHEN 'debit' THEN
             COALESCE(SUM(l.base_amount_minor) FILTER (WHERE l.side = 'debit'), 0)
             - COALESCE(SUM(l.base_amount_minor) FILTER (WHERE l.side = 'credit'), 0)
           ELSE
             COALESCE(SUM(l.base_amount_minor) FILTER (WHERE l.side = 'credit'), 0)
             - COALESCE(SUM(l.base_amount_minor) FILTER (WHERE l.side = 'debit'), 0)
         END,
         now()
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    JOIN accounts a ON a.id = l.account_id
   WHERE e.status IN ('posted', 'reversed')
     AND (p_tenant IS NULL OR l.tenant_id = p_tenant)
   GROUP BY l.tenant_id, l.account_id, e.period_id, l.currency_code, a.normal_balance;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;

/*
 * Invariant 10 — the trial balance must sum to zero for every tenant and
 * every currency. One row per (tenant, currency) that is out of balance;
 * an empty result is a healthy ledger.
 */
CREATE OR REPLACE FUNCTION ledger_verify(p_tenant UUID DEFAULT NULL)
RETURNS TABLE (
  tenant_id     UUID,
  currency_code CHAR(3),
  debit_total   BIGINT,
  credit_total  BIGINT,
  difference    BIGINT
)
LANGUAGE sql STABLE AS $$
  SELECT l.tenant_id,
         l.currency_code,
         COALESCE(SUM(l.amount_minor) FILTER (WHERE l.side = 'debit'), 0)::bigint,
         COALESCE(SUM(l.amount_minor) FILTER (WHERE l.side = 'credit'), 0)::bigint,
         (COALESCE(SUM(l.amount_minor) FILTER (WHERE l.side = 'debit'), 0)
          - COALESCE(SUM(l.amount_minor) FILTER (WHERE l.side = 'credit'), 0))::bigint
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
   WHERE e.status IN ('posted', 'reversed')
     AND (p_tenant IS NULL OR l.tenant_id = p_tenant)
   GROUP BY l.tenant_id, l.currency_code
  HAVING COALESCE(SUM(l.amount_minor) FILTER (WHERE l.side = 'debit'), 0)
       <> COALESCE(SUM(l.amount_minor) FILTER (WHERE l.side = 'credit'), 0);
$$;

-- A read-only trial balance straight from the source of truth.
CREATE OR REPLACE VIEW trial_balance_view AS
SELECT l.tenant_id,
       e.period_id,
       l.account_id,
       a.code  AS account_code,
       a.name  AS account_name,
       a.type  AS account_type,
       a.normal_balance,
       e.base_currency AS currency_code,
       COALESCE(SUM(l.base_amount_minor) FILTER (WHERE l.side = 'debit'), 0)::bigint  AS debit_total,
       COALESCE(SUM(l.base_amount_minor) FILTER (WHERE l.side = 'credit'), 0)::bigint AS credit_total
  FROM journal_lines l
  JOIN journal_entries e ON e.id = l.entry_id
  JOIN accounts a ON a.id = l.account_id
 WHERE e.status IN ('posted', 'reversed')
 GROUP BY l.tenant_id, e.period_id, l.account_id, a.code, a.name, a.type, a.normal_balance, e.base_currency;

-- ---------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------

CREATE TRIGGER tenants_set_updated_at        BEFORE UPDATE ON tenants        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_set_updated_at          BEFORE UPDATE ON users          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER currencies_set_updated_at     BEFORE UPDATE ON currencies     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER exchange_rates_set_updated_at BEFORE UPDATE ON exchange_rates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER fiscal_years_set_updated_at   BEFORE UPDATE ON fiscal_years   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER fiscal_periods_set_updated_at BEFORE UPDATE ON fiscal_periods FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER accounts_set_updated_at       BEFORE UPDATE ON accounts       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
