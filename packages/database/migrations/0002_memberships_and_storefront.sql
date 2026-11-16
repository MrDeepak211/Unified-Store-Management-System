-- Tenant membership and storefront configuration.
CREATE TABLE tenant_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  auth_subject text NOT NULL,
  email text,
  role text NOT NULL CHECK (role IN ('owner','admin','manager','cashier','viewer')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, auth_subject)
);
CREATE INDEX tenant_memberships_subject_idx ON tenant_memberships (auth_subject, is_active);

CREATE TABLE storefront_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  primary_color text NOT NULL DEFAULT '#2563eb',
  logo_url text,
  support_email text,
  support_phone text,
  is_published boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The API sets app.tenant_id inside each transaction after authenticating membership
-- (or resolving a public storefront slug). The runtime DB role must not own these tables
-- and must not have BYPASSRLS.
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE storefront_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY branches_tenant_policy ON branches
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY products_tenant_policy ON products
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY inventory_balances_tenant_policy ON inventory_balances
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY inventory_movements_tenant_policy ON inventory_movements
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY sales_orders_tenant_policy ON sales_orders
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY sales_order_items_tenant_policy ON sales_order_items
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_memberships_tenant_policy ON tenant_memberships
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY storefront_settings_tenant_policy ON storefront_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Ensure every tenant's order items can only reference products from that same tenant.
ALTER TABLE sales_order_items
  ADD CONSTRAINT sales_order_items_order_tenant_fk
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT;
