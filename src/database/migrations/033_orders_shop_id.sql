-- 033_orders_shop_id.sql
-- Multi-vendor: associate each order with a Shop.
--
-- Adds vendor_id FK on orders so that the Order_Splitter (req 5.6) can produce
-- one order per Shop at checkout, and so that downstream queries (vendor
-- dashboards, settlement worker, payout history) can scope orders by Shop.
--
-- Idempotent (req 15.8): ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
--
-- Nullability:
--   vendor_id is intentionally NULLABLE for now. Existing pre-multi-vendor
--   orders have no associated shop and would otherwise break the migration.
--   The OrderSplitter introduced in task 6.2 populates vendor_id on every new
--   order. A follow-up migration may backfill historical rows and tighten
--   the column to NOT NULL once all legacy orders have been resolved.
--
-- Index:
--   The composite (vendor_id, status, created_at DESC) supports the dominant
--   vendor-dashboard access pattern: "list a shop's orders, filtered by
--   status, newest first". A partial predicate (vendor_id IS NOT NULL) keeps
--   the index small during the transition period while many rows still
--   carry NULL vendor_id.

-- ═══════════════════════════════════════════════════════════════
-- 1. ADD vendor_id COLUMN TO orders
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS vendor_id UUID REFERENCES vendors(id);

-- ═══════════════════════════════════════════════════════════════
-- 2. INDEX FOR SHOP-SCOPED ORDER LISTINGS
-- ═══════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_orders_shop_id_status_created
  ON orders (vendor_id, status, created_at DESC)
  WHERE vendor_id IS NOT NULL;
