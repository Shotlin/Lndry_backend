-- 152_vendor_offering.sql
--
-- Vendor Offering: WHICH LNDRY products a vendor is entitled to use in the
-- Vendor App. Set by an admin (or by the vendor through POS onboarding) and
-- read by the app at login to decide which modes exist for that vendor.
--
--   MARKETPLACE  Customers book through the LNDRY customer app (the vendor
--                app's original behaviour).
--   POS          Counter billing + CRM only. Not listed in the customer app,
--                no marketplace KYC / radius / review.
--   BOTH         Either; the vendor switches mode in the app's Settings.
--
-- This is a DIFFERENT axis from vendors.vendor_type (143_vendor_types.sql),
-- which only controls whether walk-in POS sales sync to the customer's LNDRY
-- app and whether the LNDRY wallet works at the counter.
--
-- Safe to deploy: every vendor that already uses the POS (counter orders, POS
-- catalogue, cash shifts, saved counter settings, or any store order pushed by the Epic POS) is backfilled to BOTH with
-- onboarding COMPLETED, so the Epic desktop / website POS keeps working exactly
-- as before. All other existing vendors stay MARKETPLACE. Enforcement of the
-- offering on routes is behind the ENFORCE_OFFERING env flag (default off).
--
-- Idempotent: the backfill runs only when the columns are first added.

DO $$
DECLARE
  first_run BOOLEAN := FALSE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vendors' AND column_name = 'offering'
  ) THEN
    first_run := TRUE;
    ALTER TABLE vendors
      ADD COLUMN offering VARCHAR(12) NOT NULL DEFAULT 'MARKETPLACE'
      CHECK (offering IN ('MARKETPLACE', 'POS', 'BOTH'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vendors' AND column_name = 'pos_onboarding_status'
  ) THEN
    ALTER TABLE vendors
      ADD COLUMN pos_onboarding_status VARCHAR(12) NOT NULL DEFAULT 'NOT_STARTED'
      CHECK (pos_onboarding_status IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vendors' AND column_name = 'pos_plan_name'
  ) THEN
    ALTER TABLE vendors ADD COLUMN pos_plan_name VARCHAR(100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vendors' AND column_name = 'pos_valid_to'
  ) THEN
    ALTER TABLE vendors ADD COLUMN pos_valid_to DATE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vendors' AND column_name = 'pos_onboarding_data'
  ) THEN
    ALTER TABLE vendors ADD COLUMN pos_onboarding_data JSONB NOT NULL DEFAULT '{}'::jsonb;
  END IF;

  IF first_run THEN
    UPDATE vendors v
       SET offering = 'BOTH',
           pos_onboarding_status = 'COMPLETED'
     WHERE EXISTS (SELECT 1 FROM store_orders so WHERE so.vendor_id = v.id)  -- any source: COUNTER or DESKTOP_PUSH from the Epic POS
        OR EXISTS (SELECT 1 FROM pos_catalogue_state pcs WHERE pcs.vendor_id = v.id)
        OR EXISTS (SELECT 1 FROM vendor_cash_shifts cs WHERE cs.vendor_id = v.id)
        OR EXISTS (SELECT 1 FROM vendor_pos_settings ps WHERE ps.vendor_id = v.id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_vendors_offering ON vendors(offering) WHERE offering <> 'MARKETPLACE';
