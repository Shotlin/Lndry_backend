-- Migration 070: Backfill vendor_applications columns that were defined in migration 062's
-- original CREATE TABLE but never landed in this environment (the migration file was extended
-- after 062 had already been applied here, so its ALTER-equivalent columns were silently missed).
-- Idempotent via IF NOT EXISTS so it's safe to run against environments that already have them.

ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS bank_account_number VARCHAR(50);
ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS bank_ifsc VARCHAR(20);
ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100);
ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS bank_holder_name VARCHAR(100);
ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS operating_hours JSONB;
ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS gst_number VARCHAR(20);
ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS pan_number VARCHAR(20);
ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS address_line2 TEXT;
ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
