-- =====================================================================
-- M12 — Multi-company: one user, several companies.
-- =====================================================================

-- A company can be deactivated without being deleted: its ledger must stay
-- readable to an auditor long after it stops trading.
ALTER TABLE tenants ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;

/*
 * `users.tenant_id` names the company a user was created in — their home. A
 * user may also be granted roles in other companies of the same group, which is
 * what `user_roles.tenant_id` already records. Membership is therefore derived
 * from the roles a user holds, never from a separate list that could disagree
 * with them.
 *
 * The lookup runs as SECURITY DEFINER for the same reason as the login path:
 * it has to read across tenants *before* a tenant is chosen, which is precisely
 * what row-level security forbids. It returns only the caller's own rows.
 */
CREATE OR REPLACE FUNCTION auth_tenants_for_user(p_user_id UUID)
RETURNS TABLE (tenant_id UUID, slug TEXT, name TEXT, base_currency CHAR(3), is_home BOOLEAN)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT DISTINCT t.id, t.slug, t.name, t.base_currency,
         (t.id = u.tenant_id) AS is_home
    FROM users u
    JOIN user_roles ur ON ur.user_id = u.id
    JOIN tenants t ON t.id = ur.tenant_id
   WHERE u.id = p_user_id
     AND u.is_active
     AND t.is_active
   ORDER BY is_home DESC, t.name;
$$;

REVOKE ALL ON FUNCTION auth_tenants_for_user(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_tenants_for_user(UUID) TO acct_app;

/* Does this user hold any role in this company? The switch endpoint asks this
 * before minting a token, so a tenant id from a request body cannot become a
 * session in a company the user was never granted. */
CREATE OR REPLACE FUNCTION auth_user_belongs_to_tenant(p_user_id UUID, p_tenant_id UUID)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles ur
      JOIN users u ON u.id = ur.user_id
      JOIN tenants t ON t.id = ur.tenant_id
     WHERE ur.user_id = p_user_id AND ur.tenant_id = p_tenant_id
       AND u.is_active AND t.is_active
  );
$$;

REVOKE ALL ON FUNCTION auth_user_belongs_to_tenant(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_user_belongs_to_tenant(UUID, UUID) TO acct_app;

/* Reading the signed-in user's own identity, before a tenant is pinned. */
CREATE OR REPLACE FUNCTION auth_user_by_id(p_user_id UUID)
RETURNS TABLE (id UUID, tenant_id UUID, email TEXT, display_name TEXT, is_active BOOLEAN)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT u.id, u.tenant_id, u.email, u.display_name, u.is_active
    FROM users u WHERE u.id = p_user_id AND u.is_active;
$$;

REVOKE ALL ON FUNCTION auth_user_by_id(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_user_by_id(UUID) TO acct_app;

/* Revoking the session being switched away from: one session, one company. */
CREATE OR REPLACE FUNCTION auth_revoke_session_by_id(p_session UUID, p_reason TEXT)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE sessions SET revoked_at = now(), revoked_reason = p_reason
   WHERE id = p_session AND revoked_at IS NULL;
$$;

REVOKE ALL ON FUNCTION auth_revoke_session_by_id(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_revoke_session_by_id(UUID, TEXT) TO acct_app;
