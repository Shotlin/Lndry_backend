-- 097_express_pickup.sql
--
-- "60-Min Express Pickup" — previously mock-only UI in the customer app,
-- never wired to any backend (the API-mode toggle was hardcoded disabled
-- with "Not available for this vendor yet"). This makes it real:
--
--   * Per-vendor availability (admin-toggled, no vendor approval needed,
--     same superpower pattern as capacity/slots/services).
--   * A platform-wide, admin-configurable fee (fee_settings, same pattern
--     as GST) rather than hardcoded — defaults to 4900 paise (₹49).
--   * Express orders bypass the vendor_slots capacity system entirely (a
--     rider is dispatched within the hour regardless of scheduled slots),
--     so order_drafts.slot_id must become nullable — it was NOT NULL with
--     a FK to vendor_slots, which assumed every draft has a scheduled slot.

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS express_pickup_available BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE fee_settings ADD COLUMN IF NOT EXISTS express_pickup_fee_paise INT NOT NULL DEFAULT 4900;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_fee_settings_express_pickup_fee'
  ) THEN
    ALTER TABLE fee_settings
      ADD CONSTRAINT chk_fee_settings_express_pickup_fee CHECK (express_pickup_fee_paise >= 0);
  END IF;
END $$;

ALTER TABLE order_drafts ALTER COLUMN slot_id DROP NOT NULL;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_express_pickup BOOLEAN NOT NULL DEFAULT false;
