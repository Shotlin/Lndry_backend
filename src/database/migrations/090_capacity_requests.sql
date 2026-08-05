-- Ongoing (post-approval) capacity-change approval workflow. A vendor's
-- daily limit (vendors.operating_hours.max_orders_per_day) previously wrote
-- instantly via PUT /vendor/capacity/daily-limit; this table makes that an
-- admin-moderated request instead.
CREATE TABLE IF NOT EXISTS capacity_requests (
  id                            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id                     UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  requested_daily_limit         INT NOT NULL CHECK (requested_daily_limit >= 1),
  current_daily_limit_snapshot  INT,
  status                        VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                                   CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  admin_note                    TEXT,
  reviewed_by                   UUID REFERENCES users(id),
  reviewed_at                   TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capacity_requests_vendor_id ON capacity_requests(vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_capacity_requests_status ON capacity_requests(status);

-- At most one pending request per vendor, enforced at the DB level. Backs
-- the upsert-replace behavior in requestCapacityChange (a vendor resubmitting
-- while a request is still pending overwrites it rather than erroring).
CREATE UNIQUE INDEX IF NOT EXISTS uq_capacity_requests_one_pending
  ON capacity_requests(vendor_id) WHERE status = 'PENDING';
