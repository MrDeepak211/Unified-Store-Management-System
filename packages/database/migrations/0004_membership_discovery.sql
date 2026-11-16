-- Let an authenticated user discover only their own active shop memberships.
CREATE POLICY tenant_memberships_self_select ON tenant_memberships
  FOR SELECT
  USING (auth_subject = current_setting('app.auth_subject', true));
