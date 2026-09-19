-- 137_vendor_inventory.sql
-- Operational supplies (detergent, hangers, packing bags, ...) a vendor tracks
-- in the Partner app's "Inventory & Supplies" screen. Until now that screen
-- kept its list only in the app's memory, so every quantity change vanished the
-- moment the screen closed. The server is now the single source of truth: every
-- device and every staff session reads and writes these rows.

CREATE TABLE IF NOT EXISTS vendor_inventory_items (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id      UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  name           VARCHAR(120) NOT NULL,
  quantity       INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  min_threshold  INTEGER NOT NULL DEFAULT 0 CHECK (min_threshold >= 0),
  unit           VARCHAR(30) NOT NULL DEFAULT 'Pieces',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One item per name per vendor (case-insensitive) — "Bleach" and "bleach"
-- would otherwise be two rows that drift apart.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_inventory_name
  ON vendor_inventory_items (vendor_id, LOWER(name));

CREATE INDEX IF NOT EXISTS idx_vendor_inventory_vendor
  ON vendor_inventory_items (vendor_id, created_at);

-- Remembers that a vendor's starter list has been created, so deleting or
-- renaming a starter item later never brings it back. One row per vendor.
CREATE TABLE IF NOT EXISTS vendor_inventory_state (
  vendor_id  UUID PRIMARY KEY REFERENCES vendors(id) ON DELETE CASCADE,
  seeded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
