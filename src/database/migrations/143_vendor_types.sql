-- 143_vendor_types.sql
--
-- Vendor Type: how much of the LNDRY ecosystem a vendor's counter (POS) is
-- connected to. Set by an admin, enforced by the backend.
--
--   STANDARD   POS only. Counter sales stay in the vendor's own POS: they never
--              reach the customer app, and the vendor has no access to LNDRY
--              wallets (no balance lookup, no redemption, no wallet payment).
--   PARTNER    Fully connected: counter sales appear in the customer's LNDRY
--              app (same verified phone) and the LNDRY wallet is usable.
--   EXCLUSIVE  Same ecosystem access as PARTNER (kept separate for its own
--              business meaning / branding).
--
-- Vendors that exist today already sync their counter sales and use the wallet,
-- so they become PARTNER (nothing changes for them on deploy). A vendor created
-- from now on starts as STANDARD (least access) until an admin promotes it.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vendors' AND column_name = 'vendor_type'
  ) THEN
    ALTER TABLE vendors
      ADD COLUMN vendor_type VARCHAR(20) NOT NULL DEFAULT 'PARTNER'
      CHECK (vendor_type IN ('STANDARD', 'PARTNER', 'EXCLUSIVE'));
    ALTER TABLE vendors ALTER COLUMN vendor_type SET DEFAULT 'STANDARD';
  END IF;
END $$;

-- A counter sale is visible in the customer's app only when this is true. It is
-- decided once, at the moment the sale is created, from the vendor's type then
-- (so a later type change never exposes — or hides — sales already rung up).
-- Existing rows keep showing (their vendors are PARTNER above); the default for
-- new rows is FALSE so a writer that forgets to set it fails closed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'store_orders' AND column_name = 'app_synced'
  ) THEN
    ALTER TABLE store_orders ADD COLUMN app_synced BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE store_orders ALTER COLUMN app_synced SET DEFAULT FALSE;
  END IF;
END $$;
