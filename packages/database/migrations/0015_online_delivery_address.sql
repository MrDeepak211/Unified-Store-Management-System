ALTER TABLE sales_orders
  ADD COLUMN customer_email text,
  ADD COLUMN shipping_address jsonb NOT NULL DEFAULT '{}'::jsonb;
