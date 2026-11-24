-- Branch-scoped stock counts. Counting never mutates inventory; approval posts audited adjustments.
CREATE TABLE inventory_count_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','cancelled')),
  created_by text NOT NULL,
  approved_by text,
  approval_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, approval_key),
  CHECK ((status = 'approved') = (approved_at IS NOT NULL AND approved_by IS NOT NULL))
);
CREATE TABLE inventory_count_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  product_id uuid NOT NULL,
  expected_quantity integer NOT NULL CHECK (expected_quantity >= 0),
  counted_quantity integer CHECK (counted_quantity IS NULL OR counted_quantity >= 0),
  counted_by text,
  counted_at timestamptz,
  posted_movement_id uuid,
  FOREIGN KEY (tenant_id, session_id) REFERENCES inventory_count_sessions(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, branch_id, product_id) REFERENCES inventory_balances(tenant_id, branch_id, product_id) ON DELETE RESTRICT,
  FOREIGN KEY (posted_movement_id) REFERENCES inventory_movements(id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, session_id, product_id),
  CHECK ((counted_quantity IS NULL) = (counted_at IS NULL AND counted_by IS NULL))
);
CREATE INDEX inventory_count_sessions_branch_time_idx ON inventory_count_sessions(tenant_id, branch_id, created_at DESC);
CREATE INDEX inventory_count_items_session_idx ON inventory_count_items(tenant_id, session_id);
ALTER TABLE inventory_count_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_count_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY inventory_count_sessions_tenant_policy ON inventory_count_sessions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY inventory_count_items_tenant_policy ON inventory_count_items
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
