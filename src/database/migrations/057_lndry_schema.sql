-- Migration 057: LNDRY laundry service booking and fulfilment domain schema
-- Rename existing retail/grocery tables, add slots, OTPs, TOTP, and watermark settings.

-- Extend role enum with VENDOR_OWNER, VENDOR_STAFF, and RIDER
DO $$
BEGIN
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'VENDOR_OWNER';
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'VENDOR_STAFF';
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'RIDER';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Extend order_status enum with WAITING_FOR_VENDOR_CONFIRMATION
DO $$
BEGIN
  ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'WAITING_FOR_VENDOR_CONFIRMATION';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 1. RENAME shops TO vendors AND MODIFY COLUMNS
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'shops') THEN
    ALTER TABLE shops RENAME TO vendors;
  END IF;
END $$;

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'DRAFT'
  CONSTRAINT chk_vendors_status CHECK (status IN ('DRAFT', 'WAITING_FOR_APPROVAL', 'CORRECTION_REQUIRED', 'APPROVED', 'REJECTED', 'SUSPENDED'));

-- 2. RENAME shop_staff TO vendor_employees AND UPDATE FK
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'shop_staff') THEN
    ALTER TABLE shop_staff RENAME TO vendor_employees;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'vendor_employees' AND column_name = 'shop_id') THEN
    ALTER TABLE vendor_employees RENAME COLUMN shop_id TO vendor_id;
  END IF;
END $$;

-- 3. RENAME products TO garment_rates
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'products') THEN
    ALTER TABLE products RENAME TO garment_rates;
  END IF;
END $$;

-- 4. RENAME shop_products TO vendor_services AND UPDATE COLUMNS
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'shop_products') THEN
    ALTER TABLE shop_products RENAME TO vendor_services;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'vendor_services' AND column_name = 'shop_id') THEN
    ALTER TABLE vendor_services RENAME COLUMN shop_id TO vendor_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'vendor_services' AND column_name = 'product_id') THEN
    ALTER TABLE vendor_services RENAME COLUMN product_id TO garment_rate_id;
  END IF;
END $$;

-- 5. UPDATE orders COLUMNS (shop_id -> vendor_id, add slots, OTPs, adjustments)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'shop_id') THEN
    ALTER TABLE orders RENAME COLUMN shop_id TO vendor_id;
  END IF;
END $$;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS vendor_slot_id UUID;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_date DATE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_otp VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_otp VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS estimated_weight DECIMAL(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS actual_weight DECIMAL(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS weight_adjustment_reason TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS weight_adjusted_by UUID REFERENCES users(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS estimated_garment_count INT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS actual_garment_count INT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS count_adjustment_reason TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS count_adjusted_by UUID REFERENCES users(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS processing_stage VARCHAR(30) DEFAULT 'Received'
  CONSTRAINT chk_orders_processing_stage CHECK (processing_stage IN ('Received', 'Washing', 'Drying', 'Ironing', 'Packed'));

-- 6. CREATE vendor_slots TABLE FOR 60-MINUTE SLOTS CAPACITY
CREATE TABLE IF NOT EXISTS vendor_slots (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id             UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  day_of_week           INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time            TIME NOT NULL,
  end_time              TIME NOT NULL,
  max_orders            INT NOT NULL DEFAULT 5 CHECK (max_orders >= 1),
  is_active             BOOLEAN DEFAULT true,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_vendor_slot UNIQUE (vendor_id, day_of_week, start_time, end_time)
);

CREATE INDEX IF NOT EXISTS idx_vendor_slots_search ON vendor_slots(vendor_id, day_of_week, is_active);

-- 7. CREATE slot_holds TABLE FOR ATOMIC ENFORCEMENT & payment window holds
CREATE TABLE IF NOT EXISTS slot_holds (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id             UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  slot_id               UUID NOT NULL REFERENCES vendor_slots(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_date          DATE NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_slot_holds_lookup ON slot_holds(slot_id, booking_date, expires_at);

-- 8. CREATE vendor_documents TABLE FOR KYC FILES
CREATE TABLE IF NOT EXISTS vendor_documents (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id             UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  document_type         VARCHAR(50) NOT NULL, -- e.g. 'owner_identity', 'shop_photo', 'registration_document', 'gst_certificate'
  file_url              TEXT NOT NULL,
  status                VARCHAR(30) NOT NULL DEFAULT 'PENDING'
                        CONSTRAINT chk_vendor_docs_status CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  rejection_reason      TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- 9. ADD TOTP 2FA TO users TABLE FOR ADMIN SECURITY
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery_codes TEXT[];

-- 10. CREATE watermark_settings TABLE FOR DOCUMENT SECURITY
CREATE TABLE IF NOT EXISTS watermark_settings (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  enabled               BOOLEAN DEFAULT false,
  text                  VARCHAR(255) DEFAULT 'For LNDRY Verification Only',
  logo_url              TEXT,
  position              VARCHAR(50) DEFAULT 'center',
  scale                 DECIMAL(3,2) DEFAULT 1.00,
  opacity               DECIMAL(3,2) DEFAULT 0.50,
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO watermark_settings (enabled, text, position, scale, opacity)
VALUES (true, 'For LNDRY Verification Only', 'center', 1.0, 0.4)
ON CONFLICT DO NOTHING;
