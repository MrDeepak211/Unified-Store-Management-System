-- Supplier purchase returns / credit notes, tied to received goods and audited stock removals.
ALTER TABLE purchase_receipt_items
  ADD CONSTRAINT purchase_receipt_items_tenant_id_unique UNIQUE (tenant_id, id);
CREATE TABLE supplier_purchase_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  purchase_receipt_id uuid NOT NULL,
  return_number text NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','cancelled')),
  subtotal numeric(12,2) NOT NULL CHECK (subtotal >= 0),
  tax_total numeric(12,2) NOT NULL CHECK (tax_total >= 0),
  credit_total numeric(12,2) NOT NULL CHECK (credit_total >= 0),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  actor_subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, return_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, purchase_receipt_id) REFERENCES purchase_receipts(tenant_id, id) ON DELETE RESTRICT
);
CREATE TABLE supplier_purchase_return_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  return_id uuid NOT NULL,
  purchase_receipt_item_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_cost numeric(12,2) NOT NULL CHECK (unit_cost >= 0),
  tax_rate numeric(5,2) NOT NULL CHECK (tax_rate >= 0 AND tax_rate <= 100),
  line_total numeric(12,2) NOT NULL CHECK (line_total >= 0),
  tax_total numeric(12,2) NOT NULL CHECK (tax_total >= 0),
  FOREIGN KEY (tenant_id, return_id) REFERENCES supplier_purchase_returns(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, purchase_receipt_item_id) REFERENCES purchase_receipt_items(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, return_id, purchase_receipt_item_id)
);
CREATE INDEX supplier_purchase_returns_supplier_time_idx
  ON supplier_purchase_returns (tenant_id, supplier_id, created_at DESC);
ALTER TABLE supplier_purchase_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_purchase_return_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY supplier_purchase_returns_tenant_policy ON supplier_purchase_returns
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY supplier_purchase_return_items_tenant_policy ON supplier_purchase_return_items
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
