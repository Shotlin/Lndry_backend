-- 114_vendor_cash_shifts.sql
--
-- Counter cash-drawer shifts for a vendor's own shop-floor operations,
-- ported from epic-laundry-desktop's cash.ts (an offline POS module). A
-- vendor opens a shift with a counted opening-cash amount, works the
-- register, then closes it with a counted amount — the difference from the
-- expected amount is the variance, which requires a supervisor note when
-- non-zero (same requirement epic enforces client-side).
--
-- "Expected cash" is not stored as a column — it's computed live from real
-- cash-mode movements during the shift window (store_orders placed with
-- payment_method='CASH', vendor_expenses recorded with payment_mode='CASH'),
-- exactly like epic's own cashShiftForTransaction/movements() functions,
-- which derive it rather than track a running balance. Only the values
-- actually known at close time (counted_cash, expected_cash as computed at
-- that moment, variance) are persisted, so a shift's close record is a
-- point-in-time snapshot, not a live-recomputed one.

CREATE TABLE IF NOT EXISTS vendor_cash_shifts (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id             UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  register              VARCHAR(80) NOT NULL DEFAULT 'Main counter',
  status                VARCHAR(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  business_date         DATE NOT NULL DEFAULT CURRENT_DATE,

  opening_cash_paise    INTEGER NOT NULL CHECK (opening_cash_paise >= 0),
  opened_by             UUID NOT NULL REFERENCES users(id),
  opened_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note                  VARCHAR(500),

  counted_cash_paise    INTEGER CHECK (counted_cash_paise >= 0),
  expected_cash_paise   INTEGER,
  variance_paise        INTEGER,
  variance_approved_by  VARCHAR(160),
  close_note            VARCHAR(500),
  closed_by             UUID REFERENCES users(id),
  closed_at             TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one open shift per register per vendor at a time (mirrors epic's
-- "a cash shift is already open for register 'X'" guard).
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_cash_shifts_open_register
  ON vendor_cash_shifts (vendor_id, register)
  WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS idx_vendor_cash_shifts_vendor ON vendor_cash_shifts(vendor_id, opened_at DESC);

-- store_orders and vendor_expenses need to know which open shift a cash
-- movement belongs to, same as epic's cash_shift_id linkage — added here
-- (not in 111_store_orders.sql) since this table didn't exist yet then.
ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS cash_shift_id UUID REFERENCES vendor_cash_shifts(id);
