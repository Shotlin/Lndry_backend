-- 122_vendor_garment_units.sql
--
-- The foundation of Tier 2 (see CLAUDE.md's POS-parity initiative): one row
-- per PHYSICAL garment, ported from epic-laundry-desktop's domain.ts
-- (GARMENT_UNIT_STATES / GARMENT_TRANSITIONS / scanLaundryGarment /
-- reprintLaundryTag / replaceLaundryTag / createPhysicalUnits).
--
-- Unlike epic (its own local order/garment tables), units here reference
-- this backend's REAL order_lines (migration 078's garment_type_id rename)
-- — a vendor generates tags for a real order's piece-counted lines once it
-- has been received and reconciled (order_lines.confirmed_quantity is the
-- real, weighed/counted-in-person total, not the customer's estimate — the
-- right number to tag from). Deliberately NOT auto-triggered by the
-- existing reconciliation flow — same caution as every other integration
-- point in this initiative (Rider Assignment Phase 2/3, First-Time-Offers):
-- a vendor explicitly generates tags for an order via its own new endpoint,
-- so zero regression risk to any order already in flight.
--
-- State names are UPPER_SNAKE (INTAKE/SORTED/...), matching this backend's
-- own convention, not epic's Title Case.

CREATE TABLE IF NOT EXISTS vendor_garment_units (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id        UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  order_id         UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_line_id    UUID NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  customer_user_id UUID NOT NULL REFERENCES users(id),
  garment_type_id  UUID NOT NULL REFERENCES garment_types(id),
  sequence         INTEGER NOT NULL CHECK (sequence > 0),
  active_tag_code  VARCHAR(40) NOT NULL,
  state            VARCHAR(12) NOT NULL DEFAULT 'INTAKE' CHECK (state IN (
                     'INTAKE', 'SORTED', 'PROCESSING', 'QC', 'REWASH', 'ASSEMBLY',
                     'RACKED', 'DISPATCHED', 'DELIVERED', 'MISSING', 'DAMAGED', 'CANCELLED'
                   )),
  location         VARCHAR(80) NOT NULL DEFAULT 'Intake',
  condition        VARCHAR(40) NOT NULL DEFAULT 'Normal',
  created_by       UUID NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_vendor_garment_units_line_sequence UNIQUE (order_line_id, sequence)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_garment_units_tag ON vendor_garment_units (active_tag_code);
CREATE INDEX IF NOT EXISTS idx_vendor_garment_units_order ON vendor_garment_units(order_id);
-- Only one garment may occupy a given rack/bin location at a time (mirrors epic's validateRackLocation).
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_garment_units_racked_location
  ON vendor_garment_units (vendor_id, lower(location)) WHERE state = 'RACKED';

CREATE TABLE IF NOT EXISTS vendor_garment_unit_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  unit_id     UUID NOT NULL REFERENCES vendor_garment_units(id) ON DELETE CASCADE,
  event_type  VARCHAR(20) NOT NULL CHECK (event_type IN ('CREATED', 'SCAN', 'STATE_TRANSITION', 'TAG_REPRINTED', 'TAG_REPLACED')),
  from_state  VARCHAR(12),
  to_state    VARCHAR(12),
  location    VARCHAR(80),
  note        VARCHAR(500),
  actor_id    UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vendor_garment_unit_events_unit ON vendor_garment_unit_events(unit_id, created_at DESC);

CREATE TABLE IF NOT EXISTS vendor_garment_tag_history (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  unit_id              UUID NOT NULL REFERENCES vendor_garment_units(id) ON DELETE CASCADE,
  tag_code             VARCHAR(40) NOT NULL,
  status               VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REPLACED', 'LOST', 'DAMAGED')),
  issued_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  issued_by            UUID NOT NULL REFERENCES users(id),
  retired_at           TIMESTAMPTZ,
  retired_by           UUID REFERENCES users(id),
  retirement_reason    VARCHAR(240),
  replacement_tag_id   UUID REFERENCES vendor_garment_tag_history(id),
  version              INTEGER NOT NULL DEFAULT 1,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_garment_tag_history_code ON vendor_garment_tag_history(tag_code);
CREATE INDEX IF NOT EXISTS idx_vendor_garment_tag_history_unit ON vendor_garment_tag_history(unit_id);
