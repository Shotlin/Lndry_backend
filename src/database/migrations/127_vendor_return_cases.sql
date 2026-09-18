-- 127_vendor_return_cases.sql
--
-- Refund/return case tracking, ported from epic-laundry-desktop's
-- returns.ts. Note: epic's own source only ever implements
-- request+list — its presenter already carries a `decisionNote` field that
-- nothing in epic writes, suggesting an approve/reject step was planned but
-- never built upstream. Ported faithfully (request + list) plus a small
-- `decide` action to actually fill that gap, since a case with no
-- resolution step isn't a usable workflow. This tracks a case only — it
-- does not execute a real refund/payment reversal (no Razorpay refund call,
-- no wallet credit); that's a deliberately separate, larger piece of work
-- if ever wanted.

CREATE TABLE IF NOT EXISTS vendor_return_cases (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id        UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  order_id         UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_user_id UUID NOT NULL REFERENCES users(id),
  amount_paise     INTEGER NOT NULL CHECK (amount_paise > 0),
  reason           VARCHAR(30) NOT NULL CHECK (reason IN ('QUALITY_ISSUE', 'SERVICE_NOT_PERFORMED', 'DUPLICATE_CHARGE', 'CUSTOMER_CANCELLATION', 'OTHER')),
  note             VARCHAR(1000),
  status           VARCHAR(12) NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED')),
  decision_note    VARCHAR(1000),
  decided_at       TIMESTAMPTZ,
  decided_by       UUID REFERENCES users(id),
  created_by       UUID NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_return_cases_vendor ON vendor_return_cases(vendor_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_return_cases_order ON vendor_return_cases(order_id);
