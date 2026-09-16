-- Refer & Earn: the actual tracked referral relationships — one row per
-- referee, ever (a referee can only ever redeem one code, enforced by the
-- UNIQUE below). Powers the customer-facing timeline (referrer's view) and
-- the platform-wide admin monitoring list.

DO $$ BEGIN
  CREATE TYPE referral_status AS ENUM ('PENDING_FIRST_ORDER', 'COMPLETED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE referral_reward_status AS ENUM ('NOT_APPLICABLE', 'PENDING', 'GRANTED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS referrals (
  id                                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  referrer_id                        UUID NOT NULL REFERENCES users(id),
  referee_id                         UUID NOT NULL UNIQUE REFERENCES users(id),

  -- Snapshot at redemption time — immutable afterwards, even if the
  -- program is later edited or deactivated.
  referral_program_id               UUID REFERENCES referral_programs(id),
  referral_code_used                VARCHAR(20),

  status                             referral_status NOT NULL DEFAULT 'PENDING_FIRST_ORDER',
  referee_signed_up_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  referee_first_order_id            UUID REFERENCES orders(id),
  referee_first_order_completed_at  TIMESTAMPTZ,

  referrer_reward_status            referral_reward_status NOT NULL DEFAULT 'PENDING',
  referrer_reward_granted_at        TIMESTAMPTZ,
  referee_reward_status             referral_reward_status NOT NULL DEFAULT 'PENDING',
  referee_reward_granted_at         TIMESTAMPTZ,

  created_at                         TIMESTAMPTZ DEFAULT NOW(),
  updated_at                         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);
