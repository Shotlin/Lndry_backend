-- Refer & Earn: redeemable "N free deliveries" ledger — the one reward
-- shape with no existing analog anywhere in this codebase (free delivery
-- elsewhere is a spend threshold or a one-shot fold-in, never a
-- decrementing count a customer earns and spends over several orders).
-- One row per (user, credit_type); granted by incrementing remaining_count,
-- consumed by decrementing it — never deleted, so the row also doubles as
-- a lifetime-earned/used audit trail once updated_at is tracked alongside it.

DO $$ BEGIN
  CREATE TYPE referral_credit_type AS ENUM ('FREE_EXPRESS_DELIVERY', 'FREE_STANDARD_DELIVERY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS referral_reward_credits (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              UUID NOT NULL REFERENCES users(id),
  credit_type          referral_credit_type NOT NULL,
  remaining_count      INT NOT NULL DEFAULT 0 CHECK (remaining_count >= 0),
  source_referral_id   UUID REFERENCES referrals(id),
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, credit_type)
);

CREATE INDEX IF NOT EXISTS idx_referral_reward_credits_user ON referral_reward_credits(user_id, credit_type);
