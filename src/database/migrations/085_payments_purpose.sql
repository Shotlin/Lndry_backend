-- Distinguishes what a payment row is for. Default 'FULL' preserves the
-- meaning of every historical row (they represented full-amount payments
-- under the pre-advance-payment checkout model) with zero backfill.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS purpose VARCHAR(20) NOT NULL DEFAULT 'FULL';
ALTER TABLE payments DROP CONSTRAINT IF EXISTS chk_payments_purpose;
ALTER TABLE payments ADD CONSTRAINT chk_payments_purpose CHECK (purpose IN ('FULL', 'ADVANCE', 'BALANCE'));

CREATE INDEX IF NOT EXISTS idx_payments_order_status ON payments(order_id, status);
