-- Bind sales idempotency keys to the original request payload.
-- Legacy rows remain NULL because their original payload cannot be reconstructed safely.
ALTER TABLE sales_orders
  ADD COLUMN request_hash text;

ALTER TABLE sales_orders
  ADD CONSTRAINT sales_orders_request_hash_format_check
  CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');
