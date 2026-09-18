-- 115_vendor_customer_ledger.sql
--
-- Per-vendor, per-customer running account ledger, ported from
-- epic-laundry-desktop's customers.ts#appendCustomerLedger — an append-only
-- debit/credit book a shop keeps on a specific customer (e.g. "owes ₹200
-- from a credit sale," "settled last week's balance"). customer_user_id is
-- nullable because a vendor may want to track a walk-in who has no LNDRY
-- account yet (same reasoning store_orders' resolve-or-not-found flow
-- already establishes) — customer_name/customer_phone is the durable
-- reference in that case.
--
-- Not auto-posted from store_orders today: every store_order is already
-- paid in full at creation (total_paise captured at sale time), so it
-- creates no debt to ledger. This table is for genuine credit/adjustment
-- bookkeeping the vendor records by hand; automatic posting can be added
-- later if/when a "pay later" counter-sale flow exists.

CREATE TABLE IF NOT EXISTS vendor_customer_ledger (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id         UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  customer_user_id  UUID REFERENCES users(id),
  customer_name     VARCHAR(160),
  customer_phone    VARCHAR(15),

  entry_type        VARCHAR(20) NOT NULL CHECK (entry_type IN (
                       'OPENING_BALANCE', 'INVOICE_DEBIT', 'PAYMENT_CREDIT',
                       'WALLET_CREDIT', 'WALLET_DEBIT', 'REFUND', 'ADJUSTMENT', 'SETTLEMENT'
                     )),
  debit_paise       INTEGER NOT NULL DEFAULT 0 CHECK (debit_paise >= 0),
  credit_paise      INTEGER NOT NULL DEFAULT 0 CHECK (credit_paise >= 0),
  CONSTRAINT chk_vendor_customer_ledger_one_side CHECK (
    (debit_paise > 0 AND credit_paise = 0) OR (credit_paise > 0 AND debit_paise = 0)
  ),

  reference_type    VARCHAR(40),
  reference_id      UUID,
  reason            VARCHAR(500),
  entry_date        DATE NOT NULL DEFAULT CURRENT_DATE,

  created_by        UUID NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_vendor_customer_ledger_identity CHECK (
    customer_user_id IS NOT NULL OR customer_name IS NOT NULL OR customer_phone IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_vendor_customer_ledger_customer
  ON vendor_customer_ledger(vendor_id, customer_user_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_customer_ledger_phone
  ON vendor_customer_ledger(vendor_id, customer_phone) WHERE customer_phone IS NOT NULL;
