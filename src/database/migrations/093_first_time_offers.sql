-- 093_first_time_offers.sql
--
-- Bakaloo feature port, Phase 3 (see CLAUDE.md's "Bakaloo Feature Port" section):
-- admin-defined rewards for a customer's first order (e.g. "first order over
-- ₹299 → free delivery"). Multiple rows can be active; the best-fit rule
-- (highest min_order_amount the order still satisfies) wins, resolved in
-- orders.service.js#prepareOrder alongside coupon validation.
--
-- Adapted from bakaloo-backend's 068_first_time_offers_and_cashback.sql +
-- 090_first_time_offer_scope_and_free_delivery.sql, deliberately dropped per
-- CLAUDE.md's scoping decision:
--   - no WALLET_CASHBACK reward type / cashback_transactions table — LNDRY's
--     wallet module is unwired (see CLAUDE.md), reactivating it is a
--     separate initiative.
--   - no applicable_category_ids/applicable_product_ids scoping — LNDRY has
--     no cart/product catalog to scope against (a laundry order is priced
--     off a single vendor quote, not a multi-item cart).
--   - no payment_method_scope — LNDRY's checkout is a two-step draft
--     (prepareOrder) → confirm (placeOrderFromDraft) flow, and payment
--     method isn't chosen until the confirm step, after the offer has
--     already been baked into the draft's fee breakdown.
--
-- Fully additive: new table only, no impact on existing orders/coupons.

CREATE TABLE IF NOT EXISTS first_time_offers (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name              VARCHAR(100) NOT NULL,
  min_order_amount  DECIMAL(10,2) NOT NULL DEFAULT 0,
  reward_type       VARCHAR(20) NOT NULL,
  reward_value      DECIMAL(10,2),
  max_discount      DECIMAL(10,2),
  unlock_coupon_id  UUID REFERENCES coupons(id),
  start_at          TIMESTAMPTZ,
  end_at            TIMESTAMPTZ,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  auto_apply        BOOLEAN NOT NULL DEFAULT true,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_first_time_offers_reward_type CHECK (
    reward_type IN ('FREE_DELIVERY', 'FLAT_DISCOUNT', 'PERCENTAGE_DISCOUNT', 'COUPON_UNLOCK')
  )
);

CREATE INDEX IF NOT EXISTS idx_first_time_offers_active
  ON first_time_offers(is_active, min_order_amount);
