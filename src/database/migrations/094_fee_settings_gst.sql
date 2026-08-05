-- 094_fee_settings_gst.sql
--
-- Bakaloo feature port, Phase 4 (see CLAUDE.md's "Bakaloo Feature Port"
-- section — Fee Settings audit): real, admin-configurable GST charged per
-- order (exclusive — added on top of subtotal + delivery + other fees),
-- computed by TotalsEngine. Defaults to gst_enabled=false so this ships
-- with zero behavior change until an admin explicitly turns it on from
-- Settings -> Platform Fees.
--
-- Adapted from bakaloo-backend's 079_gst_tax_settings.sql. Deliberately
-- NOT porting quick_delivery_surcharge_* (071_asap_surcharge_and_store_
-- status.sql) in this same phase — that feature needs a customer-facing
-- "Quick Delivery" opt-in at checkout (new orders.quick_delivery_selected
-- column + a mobile-app toggle) that doesn't exist anywhere in LNDRY's
-- checkout flow, and Bakaloo's own dashboard never even exposed it in the
-- UI either. Out of scope for a fee-settings audit; a future phase if the
-- customer-facing feature itself is ever requested.

ALTER TABLE fee_settings ADD COLUMN IF NOT EXISTS gst_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE fee_settings ADD COLUMN IF NOT EXISTS gst_rate DECIMAL(5,2) NOT NULL DEFAULT 18.00;
ALTER TABLE fee_settings ADD COLUMN IF NOT EXISTS gst_label VARCHAR(60) NOT NULL DEFAULT 'GST';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_fee_settings_gst_rate'
  ) THEN
    ALTER TABLE fee_settings
      ADD CONSTRAINT chk_fee_settings_gst_rate CHECK (gst_rate >= 0 AND gst_rate <= 100);
  END IF;
END $$;
