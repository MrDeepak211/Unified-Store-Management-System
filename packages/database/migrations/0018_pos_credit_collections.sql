CREATE TABLE pos_credit_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  sales_order_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  payment_method text NOT NULL CHECK (payment_method IN ('cash','upi','card','bank_transfer')),
  reference text,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  collected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX pos_credit_collections_order_idx ON pos_credit_collections (tenant_id, sales_order_id, collected_at DESC);
ALTER TABLE pos_credit_collections ENABLE ROW LEVEL SECURITY;
CREATE POLICY pos_credit_collections_tenant_policy ON pos_credit_collections
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
