-- 125_vendor_production_tasks.sql
--
-- Floor work queue, ported from epic-laundry-desktop's production.ts. A task
-- is created automatically whenever a garment unit (migration 122) moves
-- into a state that maps to a physical station (Sorted->Sorting,
-- Processing->Processing, QC->Quality control, Rewash->Rewash,
-- Assembly->Assembly, Racked->Rack, Dispatched->Dispatch — Delivered/
-- Missing/Damaged/Cancelled create none, mirroring epic's terminalStates/
-- stationForState), and any still-open task for that unit is auto-completed
-- the moment it moves again — wired into vendor-garment-units.service.js's
-- scan(), not a separate manual step.
--
-- Deliberately ported WITHOUT epic's workload-recommendation/supervisor-
-- metrics/schedule reporting functions (productionWorkload,
-- productionSupervisorMetrics, productionSchedule) — those are read-only
-- analytics over this same table and can be added later without any schema
-- change; core task lifecycle (create/assign/start/complete) is what
-- actually gates floor operations.

CREATE TABLE IF NOT EXISTS vendor_production_tasks (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id        UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  garment_unit_id  UUID NOT NULL REFERENCES vendor_garment_units(id) ON DELETE CASCADE,
  order_id         UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  station          VARCHAR(20) NOT NULL,
  kind             VARCHAR(12) NOT NULL,
  status           VARCHAR(12) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED', 'CANCELLED')),
  priority         VARCHAR(10) NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL', 'URGENT')),
  assigned_to      UUID REFERENCES vendor_employees(id),
  reason           VARCHAR(500),
  completion_note  VARCHAR(500),
  output_state     VARCHAR(12),
  started_at       TIMESTAMPTZ,
  started_by       UUID REFERENCES users(id),
  completed_at     TIMESTAMPTZ,
  completed_by     UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_production_tasks_vendor ON vendor_production_tasks(vendor_id, status, priority);
CREATE INDEX IF NOT EXISTS idx_vendor_production_tasks_unit ON vendor_production_tasks(garment_unit_id, status);
