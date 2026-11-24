-- Extend request-bound idempotency to the remaining stock and cash mutations.
-- Legacy rows have no verifiable request fingerprint and are conservatively rejected on replay.
ALTER TABLE purchase_receipts ADD COLUMN request_hash text;
ALTER TABLE inventory_transfers ADD COLUMN request_hash text;
ALTER TABLE sales_returns ADD COLUMN request_hash text;
ALTER TABLE expenses ADD COLUMN request_hash text;

ALTER TABLE purchase_receipts ADD CONSTRAINT purchase_receipts_request_hash_format_check
  CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE inventory_transfers ADD CONSTRAINT inventory_transfers_request_hash_format_check
  CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE sales_returns ADD CONSTRAINT sales_returns_request_hash_format_check
  CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE expenses ADD CONSTRAINT expenses_request_hash_format_check
  CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');
