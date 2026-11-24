-- Supplier payment and credit-note allocation to received purchase receipts.
CREATE TABLE supplier_payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('payment','credit_note')),
  source_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  allocation_batch_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  actor_subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key, receipt_id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES purchase_receipts(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX supplier_payment_allocations_source_idx
  ON supplier_payment_allocations (tenant_id, source_type, source_id);
CREATE INDEX supplier_payment_allocations_receipt_idx
  ON supplier_payment_allocations (tenant_id, receipt_id);
ALTER TABLE supplier_payment_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY supplier_payment_allocations_tenant_policy ON supplier_payment_allocations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
