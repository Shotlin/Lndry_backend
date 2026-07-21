-- Migration 067: Fix vendor_services schema for Phase 1 LNDRY model (ON CONFLICT constraints and columns)

-- 1. Deduplicate vendor_services where (vendor_id, category_id) has multiple entries due to legacy backfill
DO $$
DECLARE
  dup RECORD;
  master_uuid UUID;
BEGIN
  FOR dup IN 
    SELECT vendor_id, category_id 
    FROM vendor_services 
    WHERE category_id IS NOT NULL 
    GROUP BY vendor_id, category_id 
    HAVING COUNT(*) > 1
  LOOP
    -- Find master record (earliest created or first found)
    SELECT id INTO master_uuid
    FROM vendor_services
    WHERE vendor_id = dup.vendor_id AND category_id = dup.category_id
    ORDER BY created_at ASC
    LIMIT 1;

    -- Reassign rates from duplicates to master record
    UPDATE vendor_service_rates
    SET vendor_service_id = master_uuid
    WHERE vendor_service_id IN (
      SELECT id FROM vendor_services 
      WHERE vendor_id = dup.vendor_id AND category_id = dup.category_id AND id != master_uuid
    ) AND NOT EXISTS (
      SELECT 1 FROM vendor_service_rates vsr2 
      WHERE vsr2.vendor_service_id = master_uuid AND vsr2.garment_type_id = vendor_service_rates.garment_type_id
    );

    -- Delete duplicates
    DELETE FROM vendor_services
    WHERE vendor_id = dup.vendor_id AND category_id = dup.category_id AND id != master_uuid;
  END LOOP;
END $$;

-- 2. Make legacy garment_rate_id nullable since vendor_services now represents canonical category-level services
ALTER TABLE vendor_services ALTER COLUMN garment_rate_id DROP NOT NULL;

-- 3. Add min_weight_kg column if not exists
ALTER TABLE vendor_services ADD COLUMN IF NOT EXISTS min_weight_kg DECIMAL(10,2) DEFAULT 1.0;

-- 4. Drop legacy unique constraint on (vendor_id, garment_rate_id) if present and add unique constraint on (vendor_id, category_id)
ALTER TABLE vendor_services DROP CONSTRAINT IF EXISTS uq_shop_products_shop_product;
ALTER TABLE vendor_services DROP CONSTRAINT IF EXISTS uq_vendor_services_vendor_category;
ALTER TABLE vendor_services ADD CONSTRAINT uq_vendor_services_vendor_category UNIQUE (vendor_id, category_id);
