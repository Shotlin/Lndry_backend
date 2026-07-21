-- Migration 062 (lndry_phase1_refactor) intended to rename
-- order_lines.garment_rate_id -> garment_type_id (its FK already points at
-- garment_types(id)), but that rename never actually took effect on this DB
-- even though 062 is recorded as applied. Read-side queries across the
-- vendor-orders and orders modules already assume the renamed column exists,
-- which is why vendor order-detail lookups fail with
-- "column ol.garment_type_id does not exist". This migration finishes the
-- rename for real; it's idempotent so it's safe regardless of the column's
-- current name.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'order_lines' AND column_name = 'garment_rate_id'
  ) THEN
    ALTER TABLE order_lines RENAME COLUMN garment_rate_id TO garment_type_id;
  END IF;
END $$;
