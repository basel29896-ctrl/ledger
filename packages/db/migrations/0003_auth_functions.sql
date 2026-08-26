-- =====================================================================
-- M2 (continued) — the authentication entry points.
--
-- Login happens BEFORE a tenant is known, so it cannot run under the
-- tenant row-level security policy: `app.tenant_id` is not set yet and the
-- policy would match nothing.
--
-- Rather than loosening the policy on `users` — which would open every row
-- to any query that forgot to set the tenant — these SECURITY DEFINER
-- functions are the only sanctioned way in. Each takes an exact key, returns
-- the minimum the caller needs, and is small enough to audit at a glance.
-- =====================================================================

CREATE OR REPLACE FUNCTION auth_find_user(p_email TEXT, p_tenant_slug TEXT DEFAULT NULL)
RETURNS TABLE (
  id            UUID,
  tenant_id     UUID,
  email         TEXT,
  display_name  TEXT,
  password_hash TEXT,
  totp_secret   TEXT,
  totp_enabled  BOOLEAN,
  is_active     BOOLEAN,
  failed_logins INTEGER,
  locked_until  TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT u.id, u.tenant_id, u.email, u.display_name, u.password_hash, u.totp_secret,
         u.totp_enabled, u.is_active, u.failed_logins, u.locked_until
    FROM users u
    JOIN tenants t ON t.id = u.tenant_id
   WHERE lower(u.email) = lower(p_email)
     AND (p_tenant_slug IS NULL OR t.slug = p_tenant_slug)
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION auth_record_login_failure(p_user UUID, p_attempts INTEGER, p_lock_minutes INTEGER)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE users
     SET failed_logins = p_attempts,
         locked_until = CASE WHEN p_lock_minutes > 0
                             THEN now() + make_interval(mins => p_lock_minutes)
                             ELSE NULL END
   WHERE id = p_user;
$$;

CREATE OR REPLACE FUNCTION auth_record_login_success(p_user UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = p_user;
$$;

CREATE OR REPLACE FUNCTION auth_permissions_for(p_tenant UUID, p_user UUID)
RETURNS TABLE (permission_code TEXT)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT DISTINCT rp.permission_code
    FROM user_roles ur
    JOIN role_permissions rp ON rp.role_id = ur.role_id
   WHERE ur.user_id = p_user AND ur.tenant_id = p_tenant
   ORDER BY rp.permission_code;
$$;

CREATE OR REPLACE FUNCTION auth_create_session(
  p_tenant UUID, p_user UUID, p_hash TEXT, p_family UUID,
  p_expires TIMESTAMPTZ, p_ip TEXT, p_user_agent TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO sessions (tenant_id, user_id, refresh_token_hash, family_id, expires_at, ip, user_agent)
  VALUES (p_tenant, p_user, p_hash, p_family, p_expires, p_ip::inet, p_user_agent)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION auth_find_session(p_hash TEXT)
RETURNS TABLE (
  id          UUID,
  tenant_id   UUID,
  user_id     UUID,
  family_id   UUID,
  expires_at  TIMESTAMPTZ,
  rotated_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  user_email  TEXT,
  user_name   TEXT,
  user_active BOOLEAN
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT s.id, s.tenant_id, s.user_id, s.family_id, s.expires_at, s.rotated_at, s.revoked_at,
         u.email, u.display_name, u.is_active
    FROM sessions s JOIN users u ON u.id = s.user_id
   WHERE s.refresh_token_hash = p_hash;
$$;

CREATE OR REPLACE FUNCTION auth_mark_session_rotated(p_session UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE sessions SET rotated_at = now() WHERE id = p_session;
$$;

/* A replayed refresh token means the token leaked. Revoke the whole family. */
CREATE OR REPLACE FUNCTION auth_revoke_family(p_family UUID, p_reason TEXT)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE sessions SET revoked_at = now(), revoked_reason = p_reason
   WHERE family_id = p_family AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION auth_revoke_session_by_hash(p_hash TEXT, p_reason TEXT)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE sessions SET revoked_at = now(), revoked_reason = p_reason
   WHERE refresh_token_hash = p_hash AND revoked_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION auth_set_totp_secret(p_user UUID, p_secret TEXT)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE users SET totp_secret = p_secret, totp_enabled = FALSE WHERE id = p_user;
$$;

CREATE OR REPLACE FUNCTION auth_enable_totp(p_user UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE users SET totp_enabled = TRUE WHERE id = p_user;
$$;

CREATE OR REPLACE FUNCTION auth_totp_secret(p_user UUID)
RETURNS TEXT
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT totp_secret FROM users WHERE id = p_user;
$$;

/* The tenant base currency is needed before any tenant-scoped query runs. */
CREATE OR REPLACE FUNCTION tenant_base_currency(p_tenant UUID)
RETURNS CHAR(3)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT base_currency FROM tenants WHERE id = p_tenant;
$$;

-- Only the application role may call these; nothing else needs them.
REVOKE ALL ON FUNCTION auth_find_user(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_record_login_failure(UUID, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_record_login_success(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_permissions_for(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_create_session(UUID, UUID, TEXT, UUID, TIMESTAMPTZ, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_find_session(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_mark_session_rotated(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_revoke_family(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_revoke_session_by_hash(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_set_totp_secret(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_enable_totp(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_totp_secret(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION tenant_base_currency(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth_find_user(TEXT, TEXT) TO acct_app;
GRANT EXECUTE ON FUNCTION auth_record_login_failure(UUID, INTEGER, INTEGER) TO acct_app;
GRANT EXECUTE ON FUNCTION auth_record_login_success(UUID) TO acct_app;
GRANT EXECUTE ON FUNCTION auth_permissions_for(UUID, UUID) TO acct_app;
GRANT EXECUTE ON FUNCTION auth_create_session(UUID, UUID, TEXT, UUID, TIMESTAMPTZ, TEXT, TEXT) TO acct_app;
GRANT EXECUTE ON FUNCTION auth_find_session(TEXT) TO acct_app;
GRANT EXECUTE ON FUNCTION auth_mark_session_rotated(UUID) TO acct_app;
GRANT EXECUTE ON FUNCTION auth_revoke_family(UUID, TEXT) TO acct_app;
GRANT EXECUTE ON FUNCTION auth_revoke_session_by_hash(TEXT, TEXT) TO acct_app;
GRANT EXECUTE ON FUNCTION auth_set_totp_secret(UUID, TEXT) TO acct_app;
GRANT EXECUTE ON FUNCTION auth_enable_totp(UUID) TO acct_app;
GRANT EXECUTE ON FUNCTION auth_totp_secret(UUID) TO acct_app;
GRANT EXECUTE ON FUNCTION tenant_base_currency(UUID) TO acct_app;
