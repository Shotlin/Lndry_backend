-- 111_store_orders.sql
--
-- "Laundry Store" walk-in/counter sales, pushed here by a vendor's own POS
-- desktop app (epic-laundry-desktop) when a walk-in customer's phone number
-- matches a real LNDRY account. Deliberately a separate table, never a row
-- in `orders`: orders.user_id is NOT NULL across every migration so far and
-- ~145 references (coupons, referrals, rider assignment, reconciliation,
-- delivery address) assume it always resolves to a real, addressable,
-- deliverable customer — none of that applies to a counter sale, which has
-- no delivery, no rider, and is already complete the instant it's rung up.
--
-- `items` is a denormalized JSONB snapshot, not normalized against real
-- catalogue ids — the desktop's own local catalogue rows don't carry the
-- remote garment_type_id/vendor_service_id they were synced from, so there's
-- no real id to link against yet. This is a display-only requirement (the
-- customer just needs to see what they bought), not an analytics one.
--
-- wallet_amount_paise/wallet_redemption_request_id are added later by
-- migration 113, once wallet_redemption_requests exists — this migration
-- never forward-references a table that doesn't exist yet.

CREATE TABLE IF NOT EXISTS store_orders (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id          UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  customer_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pos_order_id       VARCHAR(100) NOT NULL,
  order_number       VARCHAR(50),
  items              JSONB NOT NULL DEFAULT '[]',
  subtotal_paise     INTEGER NOT NULL DEFAULT 0,
  discount_paise     INTEGER NOT NULL DEFAULT 0,
  tax_paise          INTEGER NOT NULL DEFAULT 0,
  total_paise        INTEGER NOT NULL CHECK (total_paise >= 0),
  payment_method     VARCHAR(20),
  placed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (vendor_id, pos_order_id)
);

CREATE INDEX IF NOT EXISTS idx_store_orders_customer ON store_orders(customer_user_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_orders_vendor   ON store_orders(vendor_id, placed_at DESC);
