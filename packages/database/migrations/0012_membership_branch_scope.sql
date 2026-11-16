ALTER TABLE tenant_memberships
  ADD COLUMN branch_ids uuid[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN tenant_memberships.branch_ids IS 'Empty means all branches; otherwise the member is restricted to these tenant branch IDs.';
