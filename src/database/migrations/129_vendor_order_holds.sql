-- 129_vendor_order_holds.sql
--
-- Counter "park this cart for later" holds with a claim/lease so two staff
-- can't silently overwrite the same in-progress sale, ported from
-- epic-laundry-desktop's holds.ts. The payload is a loosely-typed JSONB
-- snapshot of an in-progress counter-sale cart (see vendor-counter-sales,
-- Tier 3 piece 1) — a hold is deliberately not itself a real record of
-- anything; it becomes real only when resumed and actually booked through
-- POST /vendor/counter-sales.
--
-- Lease duration is a fixed 15 minutes (a service-layer constant, not a
-- dashboard-configurable setting like rider-assignment's broadcast timeout
-- — this is a much smaller, lower-stakes knob and a full settings module
-- for it wasn't worth the added scope).

CREATE TABLE IF NOT EXISTS vendor_order_holds (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id            UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  hold_code            VARCHAR(20) NOT NULL,
  status               VARCHAR(10) NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD', 'RESUMED', 'CANCELLED')),
  payload              JSONB NOT NULL,
  owner_user_id        UUID REFERENCES users(id),
  ownership_updated_at TIMESTAMPTZ,
  resumed_by           UUID REFERENCES users(id),
  resumed_at           TIMESTAMPTZ,
  cancelled_by         UUID REFERENCES users(id),
  cancelled_at         TIMESTAMPTZ,
  created_by           UUID NOT NULL REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_order_holds_code ON vendor_order_holds(vendor_id, hold_code);
CREATE INDEX IF NOT EXISTS idx_vendor_order_holds_vendor ON vendor_order_holds(vendor_id, status);
