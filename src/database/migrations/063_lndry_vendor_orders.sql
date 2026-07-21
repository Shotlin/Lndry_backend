-- Migration 063: LNDRY Phase 1 - Vendor order management support
-- Extends order_assignments for PICKUP/DELIVERY assignment types,
-- adds employee_id alias and vendor_id for same-vendor assignment queries.

-- 1. Add assignment_type column to order_assignments (PICKUP or DELIVERY)
ALTER TABLE order_assignments ADD COLUMN IF NOT EXISTS assignment_type VARCHAR(30)
  DEFAULT 'DELIVERY'
  CHECK (assignment_type IN ('PICKUP', 'DELIVERY'));

-- 2. Add employee_id column as alias for rider_id (new LNDRY nomenclature)
ALTER TABLE order_assignments ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES users(id);

-- Sync existing rider_id to employee_id
UPDATE order_assignments SET employee_id = rider_id WHERE employee_id IS NULL AND rider_id IS NOT NULL;

-- 3. Add vendor_id for same-vendor scoped queries
ALTER TABLE order_assignments ADD COLUMN IF NOT EXISTS vendor_id UUID REFERENCES vendors(id);

-- 4. Unique constraint: one assignment per order per type
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_order_assignments_order_type'
  ) THEN
    -- Avoid conflict: first drop duplicates keeping the latest one
    DELETE FROM order_assignments a USING order_assignments b
    WHERE a.id < b.id AND a.order_id = b.order_id AND a.assignment_type = b.assignment_type;

    ALTER TABLE order_assignments ADD CONSTRAINT uq_order_assignments_order_type
      UNIQUE (order_id, assignment_type);
  END IF;
END $$;

-- 5. Index for workload query (employee active jobs count)
CREATE INDEX IF NOT EXISTS idx_order_assignments_employee_status
  ON order_assignments(employee_id, status) WHERE status IN ('ASSIGNED', 'IN_TRANSIT');

-- 6. Add processing_stage column to orders if not exists
ALTER TABLE orders ADD COLUMN IF NOT EXISTS processing_stage VARCHAR(50);

-- 7. Ensure order_drafts table exists for the draft checkout flow
CREATE TABLE IF NOT EXISTS order_drafts (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vendor_id             UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  slot_id               UUID,
  address_id            UUID,
  garment_lines         JSONB,
  estimated_weight      DECIMAL(10,2),
  payable_amount_paise  INTEGER NOT NULL,
  snapshot              JSONB,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Add LNDRY-specific columns to orders if not present
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_otp VARCHAR(6);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_otp VARCHAR(6);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS estimated_amount_paise INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payable_amount_paise INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_breakdown JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS vendor_slot_id UUID;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_date DATE;

-- 9. Add order_draft_id to payments for draft-based checkout flow
ALTER TABLE payments ADD COLUMN IF NOT EXISTS order_draft_id UUID;

-- 10. Ensure order_events and order_status_history tables exist
CREATE TABLE IF NOT EXISTS order_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  old_status      VARCHAR(50),
  new_status      VARCHAR(50) NOT NULL,
  actor_id        UUID REFERENCES users(id),
  actor_role      VARCHAR(50),
  note            TEXT,
  request_id      VARCHAR(255),
  timestamp       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id, timestamp);

CREATE TABLE IF NOT EXISTS order_status_history (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status     VARCHAR(50),
  to_status       VARCHAR(50) NOT NULL,
  changed_by      UUID REFERENCES users(id),
  note            TEXT,
  changed_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_status_history_order ON order_status_history(order_id, changed_at);
