-- Invoice numbering and immutable item/issuer snapshots.
ALTER TABLE tenants
  ADD COLUMN legal_name text,
  ADD COLUMN gstin text,
  ADD COLUMN state_code char(2),
  ADD COLUMN business_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN timezone text NOT NULL DEFAULT 'Asia/Kolkata';

ALTER TABLE products
  ADD COLUMN hsn_code text,
  ADD COLUMN unit_of_measure text NOT NULL DEFAULT 'PCS';

ALTER TABLE sales_orders
  ADD COLUMN invoice_number text,
  ADD COLUMN invoice_issued_at timestamptz,
  ADD COLUMN invoice_issuer_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN invoice_customer_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE sales_order_items
  ADD COLUMN product_name_snapshot text,
  ADD COLUMN sku_snapshot text,
  ADD COLUMN hsn_code_snapshot text,
  ADD COLUMN unit_of_measure_snapshot text NOT NULL DEFAULT 'PCS';

ALTER TABLE customers ADD COLUMN state_code char(2);

CREATE UNIQUE INDEX sales_orders_tenant_invoice_number_idx
  ON sales_orders (tenant_id, invoice_number)
  WHERE invoice_number IS NOT NULL;

CREATE TABLE invoice_sequences (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  financial_year text NOT NULL,
  last_number bigint NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  PRIMARY KEY (tenant_id, financial_year)
);
ALTER TABLE invoice_sequences ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_sequences_tenant_policy ON invoice_sequences
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
