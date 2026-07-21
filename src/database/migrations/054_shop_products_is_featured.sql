-- 054_shop_products_is_featured.sql
-- Add is_featured column to vendor_services so per-shop featured status
-- can be set independently of the master-catalog is_featured flag.
-- Idempotent: ADD COLUMN IF NOT EXISTS + UPDATE defaulting existing rows to false.

ALTER TABLE vendor_services
  ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN vendor_services.is_featured IS
  'Per-shop featured flag, independent of garment_rates.is_featured.';
