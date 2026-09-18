-- 116_vendor_expenses.sql
--
-- Shop-floor expense tracking, ported from epic-laundry-desktop's
-- domain.ts#createLaundryExpense/editLaundryExpense/cancelLaundryExpense.
-- Deliberately dropped: epic's journal_entry/chart-of-accounts double-entry
-- posting — Lndry_backend has no general-ledger module at all (a genuinely
-- new, much larger undertaking, out of scope here); this table is the
-- expense record itself, which is what the vendor actually looks at.
--
-- attachment_url (not epic's inline base64 blob) matches the convention
-- already established for photo evidence elsewhere in this codebase
-- (reconciliation-problem photos, category images) — an already-hosted URL,
-- not a blob stored in Postgres.
--
-- cash_shift_id links a cash-mode expense to the shift it was paid out of,
-- mirroring vendor_cash_shifts' movement computation (114).

CREATE TABLE IF NOT EXISTS vendor_expenses (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id           UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,

  expense_name        VARCHAR(160) NOT NULL,
  expense_date        DATE NOT NULL,
  amount_paise        INTEGER NOT NULL CHECK (amount_paise > 0),
  category            VARCHAR(60) NOT NULL DEFAULT 'UNCLASSIFIED',
  payment_receiver    VARCHAR(160),
  invoice_number      VARCHAR(80),
  is_tax_paid         BOOLEAN NOT NULL DEFAULT false,
  payment_mode        VARCHAR(20) NOT NULL DEFAULT 'CASH'
                       CHECK (payment_mode IN ('CASH', 'UPI', 'BANK_TRANSFER', 'CARD', 'OTHER')),
  cash_shift_id       UUID REFERENCES vendor_cash_shifts(id),
  notes               VARCHAR(1000),
  attachment_url      TEXT,

  status              VARCHAR(10) NOT NULL DEFAULT 'PAID' CHECK (status IN ('PAID', 'CANCELLED')),
  cancellation_reason VARCHAR(500),
  edit_reason         VARCHAR(500),

  created_by          UUID NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_expenses_vendor ON vendor_expenses(vendor_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_expenses_shift ON vendor_expenses(cash_shift_id) WHERE cash_shift_id IS NOT NULL;
