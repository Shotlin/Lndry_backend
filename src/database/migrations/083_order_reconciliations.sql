-- One row per correction attempt against an order: the rider's immediate
-- doorstep weigh-in (stage=RIDER_PICKUP, status=APPLIED the instant it's
-- written) and each vendor authoritative recalculation (stage=VENDOR_RECEIPT,
-- status=PENDING_CUSTOMER until the customer accepts/rejects it). Gives one
-- unified, queryable correction history per order: self-declared -> rider-
-- corrected -> vendor-proposed -> customer-decided.
CREATE TABLE IF NOT EXISTS order_reconciliations (
  id                             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id                       UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  stage                          VARCHAR(20) NOT NULL CHECK (stage IN ('RIDER_PICKUP', 'VENDOR_RECEIPT')),
  status                         VARCHAR(20) NOT NULL DEFAULT 'APPLIED'
                                    CHECK (status IN ('APPLIED', 'PENDING_CUSTOMER', 'ACCEPTED', 'REJECTED')),
  proposed_by                    UUID REFERENCES users(id),
  proposed_by_role               VARCHAR(50),
  previous_subtotal_paise        INTEGER NOT NULL,
  proposed_subtotal_paise        INTEGER NOT NULL,
  previous_payable_amount_paise  INTEGER NOT NULL,
  proposed_payable_amount_paise  INTEGER NOT NULL,
  previous_weight_kg             NUMERIC(6,2),
  proposed_weight_kg             NUMERIC(6,2),
  line_changes                   JSONB NOT NULL DEFAULT '[]',
  reason                         VARCHAR(500),
  customer_decision_at           TIMESTAMPTZ,
  customer_decision_by           UUID REFERENCES users(id),
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_reconciliations_order ON order_reconciliations(order_id, created_at DESC);

-- At most one active customer-facing proposal per order, enforced at the DB
-- level so two concurrent vendor submissions can never both succeed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_order_reconciliations_one_pending
  ON order_reconciliations(order_id) WHERE status = 'PENDING_CUSTOMER';
