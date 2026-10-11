-- 153_counter_order_delivery_flags.sql
--
-- Counter (POS) orders get two display/ops flags used by the Vendor App's POS mode
-- (Book Order toggles "Home Delivery" / "Pickup order" / "Express"):
--
--   delivery_mode  WALK_IN        customer drops off and collects at the counter (default; every existing row)
--                  HOME_DELIVERY  shop delivers the finished order to the customer
--                  PICKUP         shop picks the garments up from the customer
--   is_express     rush order
--
-- Purely additive: existing rows keep WALK_IN / FALSE, so Epic desktop / website
-- behaviour and every existing query are unchanged. Idempotent.

ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS delivery_mode VARCHAR(15) NOT NULL DEFAULT 'WALK_IN';
ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS is_express BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_orders_delivery_mode_check') THEN
    ALTER TABLE store_orders ADD CONSTRAINT store_orders_delivery_mode_check
      CHECK (delivery_mode IN ('WALK_IN', 'HOME_DELIVERY', 'PICKUP'));
  END IF;
END $$;

-- Home tiles ("Express", "Unassigned pickups") filter by vendor + flag on open orders.
CREATE INDEX IF NOT EXISTS idx_store_orders_vendor_open_flags
  ON store_orders (vendor_id, delivery_mode, is_express)
  WHERE status NOT IN ('DELIVERED', 'CANCELLED');
