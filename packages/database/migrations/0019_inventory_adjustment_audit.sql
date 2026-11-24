-- Preserve the context and exact request behind every manual stock adjustment.
ALTER TABLE inventory_movements ADD COLUMN request_hash text;
ALTER TABLE inventory_movements ADD COLUMN adjustment_reason text;
ALTER TABLE inventory_movements ADD COLUMN quantity_before integer;
ALTER TABLE inventory_movements ADD COLUMN quantity_after integer;
ALTER TABLE inventory_movements ADD COLUMN actor_subject text;

ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_request_hash_check
  CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_adjustment_audit_check
  CHECK (
    movement_type <> 'adjustment' OR request_hash IS NULL
    OR (
      adjustment_reason IS NOT NULL
      AND adjustment_reason IN ('damage','shrinkage','correction','opening_balance','found_stock','other')
      AND quantity_before IS NOT NULL AND quantity_before >= 0
      AND quantity_after IS NOT NULL AND quantity_after >= 0
      AND quantity_after - quantity_before = quantity_delta
      AND actor_subject IS NOT NULL
    )
  );
