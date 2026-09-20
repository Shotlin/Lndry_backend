-- 146_wallet_redemption_hold.sql
--
-- Wallet redemption at a laundry counter is now TWO steps, and money moves only in the second:
--
--   1. The customer approves with the one-time code  -> AUTHORIZED: the amount is RESERVED on the wallet
--      (hold_expires_at, 15 minutes). No wallet debit happens. The customer's balance is untouched, but
--      the reserved amount is not spendable elsewhere while the reservation lasts.
--   2. The sale is booked                              -> CONFIRMED: the wallet is debited IN THE SAME
--      DATABASE TRANSACTION that creates the order (captured_paise = what the sale actually used).
--      If the booking fails, nothing moved. If nobody books within 15 minutes, the reservation simply
--      lapses (EXPIRED) — the money never left.
--
-- Before this, step 1 debited the wallet immediately, so an approved-but-never-booked (or booked-without-it)
-- redemption took the customer's money for nothing. Those older debits (status CONFIRMED, debited at approval,
-- no sale) are returned automatically by the wallet reconciliation worker and marked REFUNDED.

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'wallet_redemption_requests'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE wallet_redemption_requests DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE wallet_redemption_requests
  ADD CONSTRAINT wallet_redemption_requests_status_check
  CHECK (status IN ('PENDING', 'AUTHORIZED', 'CONFIRMED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'REFUNDED'));

ALTER TABLE wallet_redemption_requests ADD COLUMN IF NOT EXISTS hold_expires_at TIMESTAMPTZ;
ALTER TABLE wallet_redemption_requests ADD COLUMN IF NOT EXISTS captured_paise INTEGER;
ALTER TABLE wallet_redemption_requests ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;

-- The "what is reserved on this wallet right now" lookup
CREATE INDEX IF NOT EXISTS idx_wallet_redemption_active_hold
  ON wallet_redemption_requests (customer_user_id) WHERE status = 'AUTHORIZED';
