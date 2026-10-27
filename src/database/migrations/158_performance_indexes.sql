-- 158_performance_indexes.sql
-- Indexes for lookups that run on every customer request but had no index
-- (found by EXPLAIN on the discovery list and by reading the hot paths).
-- All IF NOT EXISTS, so safe to re-run. Non-concurrent builds take a short
-- write lock; on a large production table run during a quiet period.

-- Discovery list: average rating + review count per vendor. Without this each
-- request scanned the whole reviews table twice per listed vendor.
CREATE INDEX IF NOT EXISTS idx_reviews_vendor_live
  ON reviews(vendor_id) INCLUDE (vendor_rating) WHERE deleted_at IS NULL;

-- Payment lookups by draft (verify, status polling, reconciliation, "already paid?").
CREATE INDEX IF NOT EXISTS idx_payments_order_draft ON payments(order_draft_id) WHERE order_draft_id IS NOT NULL;

-- Login fallback ("latest challenge for this phone") and cleanup.
CREATE INDEX IF NOT EXISTS idx_otp_challenges_phone_created ON otp_challenges(phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_challenges_created ON otp_challenges(created_at);

-- One-live-hold-per-customer-per-laundry supersede step in holdSlot.
CREATE INDEX IF NOT EXISTS idx_slot_holds_customer_vendor_active
  ON slot_holds(customer_id, vendor_id) WHERE status = 'ACTIVE';

-- "My orders" pages: newest first for one customer.
CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id, created_at DESC);

-- Wallet history.
CREATE INDEX IF NOT EXISTS idx_wallet_tx_wallet_created ON wallet_transactions(wallet_id, created_at DESC);

-- Saved-address list.
CREATE INDEX IF NOT EXISTS idx_addresses_user_created ON addresses(user_id, created_at DESC);

-- Drafts per customer (checkout cleanup / recovery listing).
CREATE INDEX IF NOT EXISTS idx_order_drafts_user_created ON order_drafts(user_id, created_at DESC);

-- Slot capacity check. placeOrderFromDraft / holdSlot / availability all count
-- the orders already booked into one slot on one date WHILE HOLDING that slot's
-- row lock. Without this the count was a sequential scan of the entire orders
-- table (every order ever placed), so the lock was held longer and longer as
-- the business grew, serialising every checkout for a laundry.
CREATE INDEX IF NOT EXISTS idx_orders_slot_date
  ON orders(vendor_slot_id, pickup_date) WHERE vendor_slot_id IS NOT NULL;
