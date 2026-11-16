ALTER TABLE sales_orders
  ADD COLUMN payment_method text NOT NULL DEFAULT 'cash'
    CHECK (payment_method IN ('cash','upi','card','bank_transfer','credit','online'));
UPDATE sales_orders SET payment_method = 'online' WHERE channel = 'online';
