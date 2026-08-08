-- 096_cart_milestones.sql
--
-- Bakaloo feature port, Phase 6 (see CLAUDE.md's "Bakaloo Feature Port"
-- section): a graduated reward ladder based on order value — e.g. "spend
-- ₹300 → unlock a coupon", "spend ₹600 → ₹50 off" — that applies to every
-- qualifying order, not just a customer's first (unlike first_time_offers).
--
-- Adapted from bakaloo-backend's 070_cart_milestones.sql, dropping the
-- CASHBACK reward type and cashback_credit_trigger column per the same
-- scoping decision as Phase 3 (first_time_offers): LNDRY's wallet/cashback
-- module is unwired, reactivating it is a separate initiative. FREE_DELIVERY
-- is excluded too, matching Bakaloo's own decision — fee_settings's
-- free_delivery_above already owns that, so admins never see two different
-- "free delivery unlocks at ₹X" settings.
--
-- message_before is a template with a literal `{amount}` placeholder the
-- backend substitutes with the live "add ₹X more" figure; message_after is
-- shown once unlocked.
--
-- Fully additive: new tables only, no impact on existing order/coupon flows
-- until an admin creates a milestone.

CREATE TABLE IF NOT EXISTS cart_milestones (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                   VARCHAR(100) NOT NULL,
  min_order_amount       DECIMAL(10,2) NOT NULL,
  reward_type            VARCHAR(20) NOT NULL,
  reward_value           DECIMAL(10,2),
  max_discount           DECIMAL(10,2),
  unlock_coupon_id       UUID REFERENCES coupons(id),
  message_before         TEXT,
  message_after          TEXT,
  is_active              BOOLEAN NOT NULL DEFAULT true,
  applicable_user_type   VARCHAR(20) NOT NULL DEFAULT 'ALL',
  applicable_segment_id  UUID REFERENCES customer_segments(id),
  stackable_with_coupon  BOOLEAN NOT NULL DEFAULT true,
  usage_limit_per_user   INTEGER,
  priority               INTEGER NOT NULL DEFAULT 0,
  created_by             UUID REFERENCES users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_cart_milestones_reward_type CHECK (
    reward_type IN ('FLAT_DISCOUNT', 'COUPON_UNLOCK')
  ),
  CONSTRAINT chk_cart_milestones_user_type CHECK (
    applicable_user_type IN ('ALL', 'FIRST_TIME', 'SEGMENT')
  )
);

CREATE INDEX IF NOT EXISTS idx_cart_milestones_active
  ON cart_milestones(is_active, min_order_amount);

-- Unlike first_time_offers (once per customer, ever), a cart milestone can
-- be earned repeatedly, so usage_limit_per_user needs something to count
-- against — mirrors coupon_usages.
CREATE TABLE IF NOT EXISTS cart_milestone_usages (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  milestone_id  UUID NOT NULL REFERENCES cart_milestones(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cart_milestone_usages_user
  ON cart_milestone_usages(milestone_id, user_id);
