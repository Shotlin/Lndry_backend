-- 123_vendor_laundry_containers.sql
--
-- Bag/container tracking for bulk (weight-based) order lines, ported from
-- epic-laundry-desktop's domain.ts (LaundryContainerState / CONTAINER_TRANSITIONS
-- / scanLaundryContainer / createLaundryContainers). Parallel to garment units
-- (migration 122) but for lines that get processed as a bag/batch rather than
-- individually tagged pieces (e.g. a kg-priced wash-and-fold order).
--
-- Same as garment units: vendor-triggered ("create N bags for this order"),
-- not auto-hooked into the existing order flow.

CREATE TABLE IF NOT EXISTS vendor_laundry_containers (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id        UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  order_id         UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_user_id UUID NOT NULL REFERENCES users(id),
  tag_code         VARCHAR(40) NOT NULL,
  sequence         INTEGER NOT NULL CHECK (sequence > 0),
  total_count      INTEGER NOT NULL CHECK (total_count > 0),
  weight_kg        NUMERIC(8,2),
  state            VARCHAR(12) NOT NULL DEFAULT 'INTAKE' CHECK (state IN (
                     'INTAKE', 'PROCESSING', 'READY', 'DISPATCHED', 'DELIVERED', 'MISSING', 'DAMAGED', 'CANCELLED'
                   )),
  location         VARCHAR(80) NOT NULL DEFAULT 'Intake',
  condition        VARCHAR(40) NOT NULL DEFAULT 'Normal',
  created_by       UUID NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_laundry_containers_tag ON vendor_laundry_containers(tag_code);
CREATE INDEX IF NOT EXISTS idx_vendor_laundry_containers_order ON vendor_laundry_containers(order_id);

CREATE TABLE IF NOT EXISTS vendor_laundry_container_events (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  container_id UUID NOT NULL REFERENCES vendor_laundry_containers(id) ON DELETE CASCADE,
  event_type   VARCHAR(20) NOT NULL CHECK (event_type IN ('CREATED', 'SCAN', 'STATE_TRANSITION')),
  from_state   VARCHAR(12),
  to_state     VARCHAR(12),
  location     VARCHAR(80),
  note         VARCHAR(500),
  actor_id     UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vendor_laundry_container_events_container ON vendor_laundry_container_events(container_id, created_at DESC);
