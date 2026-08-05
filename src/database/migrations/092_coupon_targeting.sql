-- 092_coupon_targeting.sql
--
-- Bakaloo feature port, Phase 2 (see CLAUDE.md's "Bakaloo Feature Port" section):
-- adds coupon targeting on top of the customer_segments tables from
-- migration 091. coupons.target_type decides who may redeem a coupon
-- (ALL / SEGMENT / INDIVIDUAL / FIRST_TIME). SEGMENT targeting points at a
-- single customer_segments row; INDIVIDUAL targeting uses the new
-- coupon_target_users join table (a coupon can list many specific
-- customers). Defaults to 'ALL' so every existing coupon keeps working
-- exactly as before — fully backward compatible, no backfill needed.
--
-- Adapted from bakaloo-backend's 067_customer_segments_and_coupon_targeting.sql
-- (coupon-targeting half only — the customer_segments tables already exist
-- here from migration 091).
--
-- Fully additive: safe defaults, new columns/table only, no impact on
-- existing coupons/orders.

ALTER TABLE coupons
  ADD COLUMN IF NOT EXISTS target_type VARCHAR(20) NOT NULL DEFAULT 'ALL',
  ADD COLUMN IF NOT EXISTS target_segment_id UUID REFERENCES customer_segments(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_coupons_target_type'
  ) THEN
    ALTER TABLE coupons
      ADD CONSTRAINT chk_coupons_target_type
      CHECK (target_type IN ('ALL', 'SEGMENT', 'INDIVIDUAL', 'FIRST_TIME'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS coupon_target_users (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  coupon_id UUID NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(coupon_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_coupon_target_users_coupon ON coupon_target_users(coupon_id);
