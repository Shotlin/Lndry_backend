-- 095_order_recovery_events.sql
--
-- Bakaloo feature port, Phase 5 (see CLAUDE.md's "Bakaloo Feature Port"
-- section) — reframed "abandoned carts" as incomplete-order recovery.
--
-- LNDRY has no cart at all; the real analog of an abandoned cart is an
-- order_drafts row (created by orders.service.js#prepareOrder) whose
-- payment never completed, so it never got promoted into a real `orders`
-- row (placeOrderFromDraft inserts the final order using the SAME id as
-- the draft — "NOT EXISTS (SELECT 1 FROM orders WHERE id = order_drafts.id)"
-- is the exact never-completed check, no extra tracking column needed).
--
-- Unlike Bakaloo's Redis-backed cart (which needed a whole Postgres
-- snapshot+detection system — abandoned_carts/abandoned_cart_items/
-- abandoned_cart_events — because the source cart vanishes with Redis TTL),
-- LNDRY's order_drafts/payments already live durably in Postgres, so all
-- that's needed here is a lightweight audit trail for the two admin
-- actions (reminder sent / coupon issued) — everything else is a live
-- query joining order_drafts + payments + users + vendors.

CREATE TABLE IF NOT EXISTS order_recovery_events (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_draft_id UUID NOT NULL REFERENCES order_drafts(id) ON DELETE CASCADE,
  event_type     VARCHAR(20) NOT NULL,
  actor_id       UUID REFERENCES users(id),
  metadata       JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_order_recovery_events_type CHECK (
    event_type IN ('REMINDER_SENT', 'COUPON_ISSUED')
  )
);

CREATE INDEX IF NOT EXISTS idx_order_recovery_events_draft ON order_recovery_events(order_draft_id);
