-- Add a third context value so the optional rider delivery-proof photo can
-- reuse the same order_pickup_photos table as pickup/reconciliation photos
-- instead of a new table.
ALTER TABLE order_pickup_photos DROP CONSTRAINT IF EXISTS chk_order_pickup_photos_context;
ALTER TABLE order_pickup_photos ADD CONSTRAINT chk_order_pickup_photos_context
  CHECK (context IN ('RIDER_PICKUP', 'VENDOR_RECONCILIATION', 'DELIVERY_PROOF'));
