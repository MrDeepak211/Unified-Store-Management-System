ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_movement_type_check;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_movement_type_check
  CHECK (movement_type IN ('opening','purchase','pos_sale','online_sale','reservation','reservation_release','return','adjustment','transfer_out','transfer_in'));

CREATE TABLE inventory_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  from_branch_id uuid NOT NULL,
  to_branch_id uuid NOT NULL,
  transfer_number text NOT NULL,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','cancelled')),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_branch_id <> to_branch_id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, transfer_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, from_branch_id) REFERENCES branches(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, to_branch_id) REFERENCES branches(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE inventory_transfer_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  transfer_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  FOREIGN KEY (tenant_id, transfer_id) REFERENCES inventory_transfers(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE inventory_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_transfer_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY inventory_transfers_tenant_policy ON inventory_transfers
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY inventory_transfer_items_tenant_policy ON inventory_transfer_items
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
