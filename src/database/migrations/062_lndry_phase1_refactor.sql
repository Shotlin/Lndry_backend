-- Migration 062: LNDRY Phase 1 schema refactor and cleanup
-- Transitions from grocery/retail model to pure service/laundry model

-- 1. RENAME categories TO service_categories
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'categories') THEN
    ALTER TABLE categories RENAME TO service_categories;
  END IF;
END $$;

-- 2. RENAME garment_rates TO garment_types AND CLEANUP
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'garment_rates') THEN
    ALTER TABLE garment_rates RENAME TO garment_types;
  END IF;
END $$;

ALTER TABLE garment_types DROP COLUMN IF EXISTS price;
ALTER TABLE garment_types DROP COLUMN IF EXISTS sale_price;
ALTER TABLE garment_types DROP COLUMN IF EXISTS description;
ALTER TABLE garment_types DROP COLUMN IF EXISTS thumbnail_url;

-- Update search trigger to exclude description
CREATE OR REPLACE FUNCTION update_product_search()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector = to_tsvector('english', COALESCE(NEW.name, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Ensure category_id exists and points to service_categories
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'garment_types' AND column_name = 'category_id') THEN
    -- Update foreign key constraint to point to service_categories
    ALTER TABLE garment_types DROP CONSTRAINT IF EXISTS products_category_id_fkey;
    ALTER TABLE garment_types ADD CONSTRAINT garment_types_category_id_fkey FOREIGN KEY (category_id) REFERENCES service_categories(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3. RENAME vendor_employees TO vendor_employees AND MODIFY ROLES
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'vendor_employees') THEN
    ALTER TABLE vendor_employees RENAME TO vendor_employees;
  END IF;
END $$;

ALTER TABLE vendor_employees DROP CONSTRAINT IF EXISTS chk_shop_staff_role;
ALTER TABLE vendor_employees ADD CONSTRAINT chk_vendor_employees_role CHECK (role IN ('VENDOR_OWNER', 'VENDOR_STAFF'));

-- 4. CREATE vendor_service_rates TABLE
CREATE TABLE IF NOT EXISTS vendor_service_rates (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_service_id     UUID NOT NULL REFERENCES vendor_services(id) ON DELETE CASCADE,
  garment_type_id       UUID NOT NULL REFERENCES garment_types(id) ON DELETE CASCADE,
  rate_paise            INTEGER NOT NULL CHECK (rate_paise >= 0),
  is_active             BOOLEAN DEFAULT true,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_vendor_service_rates_service_garment UNIQUE (vendor_service_id, garment_type_id)
);

CREATE INDEX IF NOT EXISTS idx_vendor_service_rates_lookup ON vendor_service_rates(vendor_service_id, garment_type_id);

-- 5. CREATE vendor_applications TABLE FOR ONBOARDING
CREATE TABLE IF NOT EXISTS vendor_applications (
  id                            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id                      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                          VARCHAR(200) NOT NULL,
  status                        VARCHAR(30) NOT NULL DEFAULT 'DRAFT'
                                CONSTRAINT chk_vendor_applications_status CHECK (status IN ('DRAFT', 'WAITING_FOR_APPROVAL', 'CORRECTION_REQUIRED', 'APPROVED', 'REJECTED')),
  email                         VARCHAR(255),
  phone                         VARCHAR(20),
  bank_account_number           VARCHAR(50),
  bank_ifsc                     VARCHAR(20),
  bank_name                     VARCHAR(100),
  bank_holder_name              VARCHAR(100),
  description                   TEXT,
  operating_hours               JSONB,
  gst_number                    VARCHAR(20),
  pan_number                    VARCHAR(20),
  address_line1                 TEXT,
  address_line2                 TEXT,
  city                          VARCHAR(100),
  state                         VARCHAR(100),
  pincode                       VARCHAR(20),
  lat                           DECIMAL(9,6),
  lng                           DECIMAL(9,6),
  requested_service_radius_km   DECIMAL(10,2) DEFAULT 5.00,
  approved_service_radius_km    DECIMAL(10,2) DEFAULT 5.00,
  rejection_reason              TEXT,
  created_at                    TIMESTAMPTZ DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ DEFAULT NOW()
);

-- 6. ALTER vendor_documents FOR ONBOARDING
ALTER TABLE vendor_documents ALTER COLUMN vendor_id DROP NOT NULL;
ALTER TABLE vendor_documents ADD COLUMN IF NOT EXISTS vendor_application_id UUID REFERENCES vendor_applications(id) ON DELETE CASCADE;

-- 7. ALTER vendors TO ADD VISIBILITY FLAGS & RADIUS
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS vendor_approved BOOLEAN DEFAULT false;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS account_enabled BOOLEAN DEFAULT true;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS marketplace_published BOOLEAN DEFAULT false;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS requested_service_radius_km DECIMAL(10,2) DEFAULT 5.00;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS approved_service_radius_km DECIMAL(10,2) DEFAULT 5.00;

-- 8. CREATE quotes TABLE
CREATE TABLE IF NOT EXISTS quotes (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vendor_id             UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  service_id            UUID REFERENCES vendor_services(id) ON DELETE CASCADE,
  estimated_weight_kg   DECIMAL(10,2),
  estimate_paise        INTEGER NOT NULL CHECK (estimate_paise >= 0),
  pricing_snapshot      JSONB NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quotes_customer_lookup ON quotes(customer_id);

-- 9. ALTER slot_holds
ALTER TABLE slot_holds ADD COLUMN IF NOT EXISTS quote_id UUID REFERENCES quotes(id) ON DELETE CASCADE;
ALTER TABLE slot_holds ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- Sync user_id to customer_id if exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'slot_holds' AND column_name = 'user_id') THEN
    UPDATE slot_holds SET customer_id = user_id WHERE customer_id IS NULL;
  END IF;
END $$;

-- 10. CREATE order_otps TABLE
CREATE TABLE IF NOT EXISTS order_otps (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id              UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  otp_hash              VARCHAR(255) NOT NULL,
  purpose               VARCHAR(50) NOT NULL CHECK (purpose IN ('PICKUP', 'DELIVERY')),
  attempt_count         INT NOT NULL DEFAULT 0,
  expires_at            TIMESTAMPTZ NOT NULL,
  consumed_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_otps_active ON order_otps(order_id, purpose) WHERE consumed_at IS NULL;

-- 11. RENAME delivery_assignments TO order_assignments
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'delivery_assignments') THEN
    ALTER TABLE delivery_assignments RENAME TO order_assignments;
  END IF;
END $$;

-- 12. CREATE OR RENAME order_lines
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'order_items') THEN
    ALTER TABLE order_items RENAME TO order_lines;
  END IF;
END $$;

-- Adjust order_lines columns to point to garment_types
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'order_lines' AND column_name = 'product_id') THEN
    ALTER TABLE order_lines RENAME COLUMN product_id TO garment_type_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'order_lines' AND column_name = 'garment_rate_id') THEN
    ALTER TABLE order_lines RENAME COLUMN garment_rate_id TO garment_type_id;
  END IF;
END $$;

ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS estimated_quantity INTEGER;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS confirmed_quantity INTEGER;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS rate_paise INTEGER;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS total_paise INTEGER;

-- Clean up any other old tables we want to drop if required, but we'll keep them inactive in migrations
