-- 157_payment_hardening.sql
-- Makes "money taken but order missing" recoverable and auditable.
--
--  1. payment_webhook_events  — every gateway event is processed exactly once
--  2. payments.failure_*      — WHY a payment failed, shown to the customer
--  3. payments.paid_at / recovery_* / last_gateway_check_at — drive the
--     reconciliation worker that finishes orders for late/lost confirmations
--  4. one PAID advance per draft (DB-level guard against double charging)
--  5. one row per Razorpay payment id (a payment can never be applied twice)
--  6. orders.order_number widened where possible (non-fatal if a view blocks it)

-- 1 ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_webhook_events (
  event_id             TEXT PRIMARY KEY,
  event_type           TEXT NOT NULL,
  razorpay_order_id    TEXT,
  razorpay_payment_id  TEXT,
  received_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at         TIMESTAMPTZ,
  attempts             INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_received ON payment_webhook_events(received_at);

-- 2 + 3 ───────────────────────────────────────────────────────────────────
ALTER TABLE payments ADD COLUMN IF NOT EXISTS failure_code          VARCHAR(100);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS failure_reason        TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS failure_source        VARCHAR(50);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS paid_at               TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS recovery_attempts     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS recovery_next_at      TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS recovery_last_error   TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS last_gateway_check_at TIMESTAMPTZ;

-- Backfill so existing PAID rows have a paid_at.
UPDATE payments SET paid_at = COALESCE(updated_at, created_at) WHERE status = 'PAID' AND paid_at IS NULL;

-- PAID payments whose order never got created (what the recovery worker hunts).
CREATE INDEX IF NOT EXISTS idx_payments_paid_unplaced
  ON payments(paid_at)
  WHERE status = 'PAID' AND order_id IS NULL AND order_draft_id IS NOT NULL;

-- Online payments still waiting for the gateway's final word.
CREATE INDEX IF NOT EXISTS idx_payments_awaiting_gateway
  ON payments(created_at)
  WHERE status IN ('PENDING', 'EXPIRED') AND razorpay_order_id IS NOT NULL;

-- 4 + 5 (only when existing data is already clean, so deploy never fails) ──
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payments
     WHERE status = 'PAID' AND purpose = 'ADVANCE' AND order_draft_id IS NOT NULL
     GROUP BY order_draft_id HAVING COUNT(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_one_paid_advance_per_draft
      ON payments(order_draft_id)
      WHERE status = 'PAID' AND purpose = 'ADVANCE' AND order_draft_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'uq_payments_one_paid_advance_per_draft NOT created: duplicate PAID advances exist — resolve them, then re-run';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM payments WHERE razorpay_payment_id IS NOT NULL
     GROUP BY razorpay_payment_id HAVING COUNT(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_razorpay_payment_id
      ON payments(razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'uq_payments_razorpay_payment_id NOT created: duplicate razorpay_payment_id values exist';
  END IF;
END $$;

-- 6 ───────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  ALTER TABLE orders ALTER COLUMN order_number TYPE VARCHAR(32);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'orders.order_number left at its current width (%). The app generates numbers that fit.', SQLERRM;
END $$;
