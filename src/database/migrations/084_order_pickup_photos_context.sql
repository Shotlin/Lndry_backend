-- Reuse the existing order_pickup_photos table for the vendor's
-- reconciliation evidence photo(s) too, rather than a new table — it's
-- already generic enough (order_id + optional order_line_id + photo_url +
-- uploaded_by). `context` snapshots which flow a photo came from as a
-- permanent fact rather than inferring rider-vs-vendor from a live join
-- against vendor_employees.role, which would silently change meaning if
-- that person's role/employment is edited later.
ALTER TABLE order_pickup_photos ADD COLUMN IF NOT EXISTS context VARCHAR(24) NOT NULL DEFAULT 'RIDER_PICKUP';
ALTER TABLE order_pickup_photos ADD COLUMN IF NOT EXISTS order_reconciliation_id UUID
  REFERENCES order_reconciliations(id) ON DELETE SET NULL;

ALTER TABLE order_pickup_photos DROP CONSTRAINT IF EXISTS chk_order_pickup_photos_context;
ALTER TABLE order_pickup_photos ADD CONSTRAINT chk_order_pickup_photos_context
  CHECK (context IN ('RIDER_PICKUP', 'VENDOR_RECONCILIATION'));
