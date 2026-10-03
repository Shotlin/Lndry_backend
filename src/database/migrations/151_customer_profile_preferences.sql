-- 151_customer_profile_preferences.sql
--
-- The counter's customer form also keeps service preferences, a preferred contact channel and marketing consent.
-- Vendor-private, like the rest of vendor_customer_profiles (migration 150). Purely additive.

ALTER TABLE vendor_customer_profiles ADD COLUMN IF NOT EXISTS service_preferences TEXT;
ALTER TABLE vendor_customer_profiles ADD COLUMN IF NOT EXISTS preferred_contact VARCHAR(20);
ALTER TABLE vendor_customer_profiles ADD COLUMN IF NOT EXISTS marketing_consent BOOLEAN;
