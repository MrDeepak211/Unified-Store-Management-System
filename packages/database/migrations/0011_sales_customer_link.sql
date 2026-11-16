ALTER TABLE sales_orders ADD COLUMN customer_id uuid;
ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_customer_tenant_fk
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT;
CREATE INDEX sales_orders_customer_idx ON sales_orders (tenant_id, customer_id, created_at DESC);
