-- 128_vendor_rider_settlements.sql
--
-- Payout accounting for an individual rider/staff member's cash handovers,
-- ported from epic-laundry-desktop's domain.ts#saveLaundryRiderSettlement.
-- Distinct from `shop-financials/payout.service.js`, which settles a whole
-- VENDOR (platform → vendor); this settles a vendor's own staff member
-- (vendor → rider) — different direction, different party.
--
-- rider_employee_id is a vendor_employees.id (this backend's real staff
-- roster, matching Rider Assignment's own convention), not epic's local
-- laundry_rider table. order_ids references real orders — validated at the
-- application layer that each one was actually assigned (via
-- order_assignments) to this rider before a settlement can claim it.
--
-- Status machine mirrors epic exactly: PENDING -> HANDED_OVER/RECONCILED/
-- REJECTED, HANDED_OVER -> RECONCILED/REJECTED, and RECONCILED/REJECTED are
-- terminal — enforced in the service layer (the same "two-step attestation
-- with a direct-to-Reconciled shortcut" epic's own comment explains).

CREATE TABLE IF NOT EXISTS vendor_rider_settlements (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id          UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  rider_employee_id  UUID NOT NULL REFERENCES vendor_employees(id),
  settlement_date    DATE NOT NULL,
  amount_paise       INTEGER NOT NULL CHECK (amount_paise > 0),
  method             VARCHAR(10) NOT NULL DEFAULT 'CASH' CHECK (method IN ('CASH', 'UPI', 'BANK')),
  status             VARCHAR(12) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'HANDED_OVER', 'RECONCILED', 'REJECTED')),
  order_ids          UUID[] NOT NULL DEFAULT '{}',
  reference          VARCHAR(120),
  notes              VARCHAR(500),
  created_by         UUID NOT NULL REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_rider_settlements_rider ON vendor_rider_settlements(rider_employee_id, settlement_date DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_rider_settlements_vendor ON vendor_rider_settlements(vendor_id, status);
