-- Returns and refund audit records. Refund settlement remains provider-dependent.
CREATE TABLE sales_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  sales_order_id uuid NOT NULL,
  return_number text NOT NULL,
  status text NOT NULL CHECK (status IN ('restocked','inspection_pending')),
  refund_status text NOT NULL DEFAULT 'pending' CHECK (refund_status IN ('pending','refunded','rejected')),
  reason text,
  total numeric(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, return_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE sales_order_items ADD CONSTRAINT sales_order_items_tenant_id_unique UNIQUE (tenant_id, id);

CREATE TABLE sales_return_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  return_id uuid NOT NULL,
  sales_order_item_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  line_total numeric(12,2) NOT NULL CHECK (line_total >= 0),
  FOREIGN KEY (tenant_id, return_id) REFERENCES sales_returns(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, sales_order_item_id) REFERENCES sales_order_items(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE sales_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_return_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY sales_returns_tenant_policy ON sales_returns
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY sales_return_items_tenant_policy ON sales_return_items
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
