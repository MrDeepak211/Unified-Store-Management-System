-- Online checkout stock reservations and order tracking.
ALTER TABLE sales_orders
  ADD COLUMN payment_status text NOT NULL DEFAULT 'not_required'
    CHECK (payment_status IN ('not_required','pending','paid','failed','refunded')),
  ADD COLUMN reservation_expires_at timestamptz,
  ADD COLUMN public_tracking_token_hash text;

CREATE UNIQUE INDEX sales_orders_tracking_token_idx
  ON sales_orders (public_tracking_token_hash)
  WHERE public_tracking_token_hash IS NOT NULL;
