-- 098_fee_settings_delivery_mode_and_vendor_commission.sql
--
-- Two additions to fee_settings, requested by the user directly:
--
-- 1. delivery_fee_mode ('FLAT' | 'DISTANCE') — an explicit switch between
--    a flat delivery fee and the existing distance-based formula
--    (min_delivery_fee + per-km beyond base_distance_km). Previously the
--    only way to get a flat fee was to zero out per_km_fee, which worked
--    but wasn't a first-class, discoverable choice. Defaults to
--    'DISTANCE' (zero behavior change for the existing formula) — the
--    GLOBAL row below is explicitly switched to 'FLAT' as part of this
--    same migration to realize the new business rule.
--
-- 2. vendor_commission_* — a reference-only global commission the
--    platform intends to charge vendors per order (flat ₹ or %, mirrors
--    the FLAT/PERCENT pattern already used by handling_fee/platform_fee).
--    Deliberately NOT wired into shop-financials/settlement.service.js
--    payout math in this migration — this is a configuration surface
--    only, so an admin can set and see the intended rate without it
--    silently changing live vendor payouts. Wiring it into real
--    settlement is a separate, explicitly-deferred follow-up.
--
-- Also applies the concrete business-rule change requested: cart value
-- below ₹499 charges a flat ₹129 delivery fee; ₹499 and above is free.
-- (Previous GLOBAL defaults were min_delivery_fee=20, free_delivery_above
-- =299, from migration 055.)

ALTER TABLE fee_settings ADD COLUMN IF NOT EXISTS delivery_fee_mode VARCHAR(10) NOT NULL DEFAULT 'DISTANCE';
ALTER TABLE fee_settings ADD COLUMN IF NOT EXISTS vendor_commission_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE fee_settings ADD COLUMN IF NOT EXISTS vendor_commission_type VARCHAR(12) NOT NULL DEFAULT 'PERCENT';
ALTER TABLE fee_settings ADD COLUMN IF NOT EXISTS vendor_commission_value DECIMAL(10,2) NOT NULL DEFAULT 10.00;
ALTER TABLE fee_settings ADD COLUMN IF NOT EXISTS vendor_commission_label VARCHAR(60) NOT NULL DEFAULT 'Vendor commission';
ALTER TABLE fee_settings ADD COLUMN IF NOT EXISTS vendor_commission_description TEXT
  DEFAULT 'Reference value for what the platform intends to charge the vendor per order. Not yet applied to vendor payouts.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_fs_delivery_fee_mode') THEN
    ALTER TABLE fee_settings
      ADD CONSTRAINT chk_fs_delivery_fee_mode CHECK (delivery_fee_mode IN ('FLAT','DISTANCE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_fs_vendor_commission_type') THEN
    ALTER TABLE fee_settings
      ADD CONSTRAINT chk_fs_vendor_commission_type CHECK (vendor_commission_type IN ('FLAT','PERCENT'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_fs_vendor_commission_value') THEN
    ALTER TABLE fee_settings
      ADD CONSTRAINT chk_fs_vendor_commission_value CHECK (vendor_commission_value >= 0);
  END IF;
END $$;

-- Apply the requested business rule to the live GLOBAL row: flat ₹129
-- delivery fee below ₹499 cart value, free at/above ₹499.
UPDATE fee_settings
SET delivery_fee_mode = 'FLAT',
    min_delivery_fee = 129.00,
    free_delivery_enabled = true,
    free_delivery_above = 499.00,
    updated_at = NOW()
WHERE scope = 'GLOBAL';
