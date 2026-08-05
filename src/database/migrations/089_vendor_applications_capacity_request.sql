-- Requested daily order capacity, collected during onboarding alongside the
-- service radius step. Nullable/no default so it can be gated as a required
-- onboarding field the same way owner_identity/shop_photo documents are.
ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS requested_daily_capacity INT;
