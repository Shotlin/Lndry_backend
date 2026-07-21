-- Migration 060: Add vendor_id, vendor_rating, rider_rating, and soft delete (deleted_at) to reviews
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS vendor_id UUID REFERENCES vendors(id) ON DELETE CASCADE;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS vendor_rating INTEGER CHECK (vendor_rating >= 1 AND vendor_rating <= 5);
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS rider_rating INTEGER CHECK (rider_rating IS NULL OR (rider_rating >= 1 AND rider_rating <= 5));
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE reviews ALTER COLUMN garment_rate_id DROP NOT NULL;
ALTER TABLE reviews ALTER COLUMN rating DROP NOT NULL;
