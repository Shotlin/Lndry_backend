-- 135_invoices.sql
-- Backend-generated customer invoices.
--
-- One invoice per delivered order, issued once and never renumbered.
--   * `snapshot` freezes every figure on the invoice (customer, vendor, lines,
--     totals, payments) at the moment it is issued, computed by the backend
--     from the real final order + payment rows. The mobile app never computes
--     or lays out an invoice — it only asks for it.
--   * The PDF is *rendered from the snapshot* by a template module
--     (src/modules/invoices/templates/). Swapping the template changes how
--     newly issued invoices look; nothing in the app or in this schema changes.
--   * The rendered PDF is stored in invoice_files (bytea) so it survives
--     container rebuilds; `pdf_ref` names where it lives so a later move to
--     object storage is a data change, not a schema change.
--
-- order_type: 'ORDER' = a pickup-and-delivery order (orders), 'STORE_ORDER' =
-- an in-person counter order (store_orders). No FK on order_id for the same
-- reason migration 130 dropped its FKs: one column, two possible tables.

CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1;

CREATE TABLE IF NOT EXISTS invoices (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_number     VARCHAR(40) NOT NULL UNIQUE,
  order_type         VARCHAR(20) NOT NULL CHECK (order_type IN ('ORDER', 'STORE_ORDER')),
  order_id           UUID NOT NULL,
  order_number       VARCHAR(60),
  customer_id        UUID NOT NULL REFERENCES users(id),
  vendor_id          UUID REFERENCES vendors(id),
  status             VARCHAR(20) NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED', 'VOID')),
  invoice_date       TIMESTAMPTZ NOT NULL,          -- delivery date (date of supply)
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  currency           VARCHAR(3) NOT NULL DEFAULT 'INR',

  -- Final totals (paise), as issued
  subtotal_paise     INTEGER NOT NULL,
  discount_paise     INTEGER NOT NULL DEFAULT 0,
  delivery_fee_paise INTEGER NOT NULL DEFAULT 0,
  platform_fee_paise INTEGER NOT NULL DEFAULT 0,
  tax_paise          INTEGER NOT NULL DEFAULT 0,
  total_paise        INTEGER NOT NULL,
  amount_paid_paise  INTEGER NOT NULL DEFAULT 0,
  balance_due_paise  INTEGER NOT NULL DEFAULT 0,
  payment_status     VARCHAR(20) NOT NULL,
  payment_method     VARCHAR(50),

  snapshot           JSONB NOT NULL,
  template_id        VARCHAR(50) NOT NULL,
  pdf_ref            TEXT,
  pdf_sha256         CHAR(64),
  pdf_size_bytes     INTEGER,
  pdf_generated_at   TIMESTAMPTZ,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The idempotency guarantee: an order can only ever have one invoice.
  CONSTRAINT uq_invoices_order UNIQUE (order_type, order_id)
);

CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices (customer_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_vendor   ON invoices (vendor_id, issued_at DESC);

CREATE TABLE IF NOT EXISTS invoice_files (
  invoice_id   UUID PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
  pdf          BYTEA NOT NULL,
  content_type VARCHAR(50) NOT NULL DEFAULT 'application/pdf',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
