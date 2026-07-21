-- Migration 065: LNDRY Phase 1 - Canonical Vendor Services schema unification, slot holds status, and status unification

-- 1. ALTER vendor_services TABLE to introduce canonical columns
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES service_categories(id) ON DELETE SET NULL;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS name VARCHAR(255);
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS inclusions TEXT[] DEFAULT '{}'::TEXT[];
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS exclusions TEXT[] DEFAULT '{}'::TEXT[];
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS completion_time_hours INT DEFAULT 24;
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS image_asset_id VARCHAR(100);
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'DRAFT';

-- 2. ALTER slot_holds TABLE to add status column
ALTER TABLE slot_holds ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'ACTIVE'
  CONSTRAINT chk_slot_holds_status CHECK (status IN ('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED'));

-- 3. UNIFY WAITING_FOR_VENDOR_CONFIRMATION status in order_status enum and historical data
-- Add 'WAITING_VENDOR_CONFIRMATION' value to order_status enum if not already present
DO $$
BEGIN
  ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'WAITING_VENDOR_CONFIRMATION';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Backfill orders and status history where WAITING_FOR_VENDOR_CONFIRMATION was used
UPDATE orders SET status = 'WAITING_VENDOR_CONFIRMATION' WHERE status = 'WAITING_FOR_VENDOR_CONFIRMATION';
UPDATE order_events SET old_status = 'WAITING_VENDOR_CONFIRMATION' WHERE old_status = 'WAITING_FOR_VENDOR_CONFIRMATION';
UPDATE order_events SET new_status = 'WAITING_VENDOR_CONFIRMATION' WHERE new_status = 'WAITING_FOR_VENDOR_CONFIRMATION';

-- 4. BACKFILL existing vendor_services.category_id from garment_types (garment_rates) category_id
-- Currently vendor_services represents vendor-garment mappings via garment_rate_id.
-- Let's extract the category_id from garment_types for existing rows.
UPDATE vendor_services vs
SET category_id = gt.category_id,
    name = sc.name,
    description = sc.description,
    status = 'PUBLISHED'
FROM garment_types gt
LEFT JOIN service_categories sc ON gt.category_id = sc.id
WHERE vs.garment_rate_id = gt.id AND vs.category_id IS NULL;

-- 5. BACKFILL vendor_services.price if NULL or 0
UPDATE vendor_services vs
SET price = CASE 
  WHEN sc.name ILIKE '%Blanket%' THEN 350.00
  WHEN sc.name ILIKE '%Carpet%' THEN 450.00
  WHEN sc.name ILIKE '%Curtain%' THEN 300.00
  WHEN sc.name ILIKE '%Dry%' THEN 250.00
  WHEN sc.name ILIKE '%Iron%' THEN 150.00
  ELSE 200.00
END
FROM service_categories sc
WHERE vs.category_id = sc.id AND (vs.price IS NULL OR vs.price <= 0);

