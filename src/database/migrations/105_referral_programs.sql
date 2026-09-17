-- Refer & Earn: admin-managed referral campaign config. Multiple programs
-- can be simultaneously active — resolved for a given referrer via
-- target_type/target_segment_id (reusing Phase 1 of the Bakaloo port's
-- customer-segment targeting) with `priority` as the tiebreaker, then
-- snapshotted onto the referrals row so a later edit here never
-- retroactively changes an in-flight referral's reward.

DO $$ BEGIN
  CREATE TYPE referral_reward_type AS ENUM (
    'WALLET_CREDIT', 'FREE_EXPRESS_DELIVERY', 'FREE_STANDARD_DELIVERY', 'COUPON_UNLOCK'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE referral_trigger_type AS ENUM ('ON_SIGNUP', 'ON_FIRST_ORDER_COMPLETE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS referral_programs (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                        VARCHAR(150) NOT NULL,
  is_active                   BOOLEAN NOT NULL DEFAULT true,

  target_type                 VARCHAR(10) NOT NULL DEFAULT 'ALL' CHECK (target_type IN ('ALL', 'SEGMENT')),
  target_segment_id           UUID REFERENCES customer_segments(id),
  priority                    INT NOT NULL DEFAULT 0,
  valid_from                  TIMESTAMPTZ,
  valid_until                 TIMESTAMPTZ,

  referrer_reward_type        referral_reward_type NOT NULL,
  referrer_reward_amount      DECIMAL(10,2),
  referrer_reward_count       INT,
  referrer_unlock_coupon_id   UUID REFERENCES coupons(id),
  referrer_trigger            referral_trigger_type NOT NULL DEFAULT 'ON_FIRST_ORDER_COMPLETE',

  referee_reward_type         referral_reward_type NOT NULL,
  referee_reward_amount       DECIMAL(10,2),
  referee_reward_count        INT,
  referee_unlock_coupon_id    UUID REFERENCES coupons(id),
  referee_trigger             referral_trigger_type NOT NULL DEFAULT 'ON_FIRST_ORDER_COMPLETE',

  max_referrals_per_referrer  INT,
  terms_text                  TEXT,

  created_by                  UUID REFERENCES users(id),
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_programs_active ON referral_programs(is_active, priority DESC);
CREATE INDEX IF NOT EXISTS idx_referral_programs_segment ON referral_programs(target_segment_id);
