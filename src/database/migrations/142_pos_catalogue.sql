-- 142_pos_catalogue.sql
--
-- The POS (in-store counter) catalogue is its own, vendor-scoped catalogue —
-- separate from the LNDRY marketplace catalogue the customer app reads
-- (service_categories / garment_types / vendor_services / vendor_service_rates).
--
--   * Each vendor gets its own POS categories (with optional sub-categories),
--     services, garments/items and prices. Every row carries vendor_id and is
--     only ever read or written for that vendor.
--   * POS-only rows (source = 'POS') never touch the marketplace and need no
--     admin approval.
--   * Rows imported from the vendor's approved marketplace services
--     (source = 'MARKETPLACE') remember where they came from
--     (marketplace_*_id) so the sync can refresh them later.
--   * A POS price is independent of the marketplace price. Editing it sets
--     price_overridden = true; the sync then keeps the vendor's POS price and
--     only refreshes marketplace_rate_paise (the reference price). Nothing here
--     ever writes back to vendor_service_rates.
--
-- POS orders (store_orders) are priced from pos_prices. Garment tags for a
-- custom POS garment have no garment_types row, so vendor_garment_units keeps
-- a garment_name snapshot and garment_type_id becomes optional.

CREATE TABLE IF NOT EXISTS pos_catalogue_state (
  vendor_id       UUID PRIMARY KEY REFERENCES vendors(id) ON DELETE CASCADE,
  initialized_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at  TIMESTAMPTZ,
  feed_hash       TEXT
);

CREATE TABLE IF NOT EXISTS pos_categories (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id               UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  parent_id               UUID REFERENCES pos_categories(id) ON DELETE SET NULL,
  name                    VARCHAR(120) NOT NULL,
  color                   VARCHAR(20),
  image_url               TEXT,
  sort_order              INTEGER NOT NULL DEFAULT 0,
  active                  BOOLEAN NOT NULL DEFAULT true,
  source                  VARCHAR(12) NOT NULL DEFAULT 'POS' CHECK (source IN ('MARKETPLACE', 'POS')),
  marketplace_category_id UUID,
  locally_edited          BOOLEAN NOT NULL DEFAULT false,
  marketplace_missing     BOOLEAN NOT NULL DEFAULT false,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_categories_marketplace
  ON pos_categories (vendor_id, marketplace_category_id) WHERE marketplace_category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pos_categories_vendor ON pos_categories (vendor_id, active);

CREATE TABLE IF NOT EXISTS pos_services (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id              UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  name                   VARCHAR(160) NOT NULL,
  description            TEXT,
  image_url              TEXT,
  units                  TEXT[] NOT NULL DEFAULT '{}',
  active                 BOOLEAN NOT NULL DEFAULT true,
  source                 VARCHAR(12) NOT NULL DEFAULT 'POS' CHECK (source IN ('MARKETPLACE', 'POS')),
  marketplace_service_id UUID,
  locally_edited         BOOLEAN NOT NULL DEFAULT false,
  marketplace_missing    BOOLEAN NOT NULL DEFAULT false,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_services_marketplace
  ON pos_services (vendor_id, marketplace_service_id) WHERE marketplace_service_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pos_services_vendor ON pos_services (vendor_id, active);

CREATE TABLE IF NOT EXISTS pos_garments (
  id                         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id                  UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  category_id                UUID REFERENCES pos_categories(id) ON DELETE SET NULL,
  name                       VARCHAR(160) NOT NULL,
  code                       VARCHAR(40),
  unit                       VARCHAR(10) NOT NULL DEFAULT 'piece' CHECK (unit IN ('piece', 'kg', 'pair', 'sqft')),
  image_url                  TEXT,
  hsn                        VARCHAR(20),
  gst_rate                   NUMERIC(5,2) NOT NULL DEFAULT 0,
  active                     BOOLEAN NOT NULL DEFAULT true,
  source                     VARCHAR(12) NOT NULL DEFAULT 'POS' CHECK (source IN ('MARKETPLACE', 'POS')),
  marketplace_garment_type_id UUID,
  locally_edited             BOOLEAN NOT NULL DEFAULT false,
  marketplace_missing        BOOLEAN NOT NULL DEFAULT false,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_garments_marketplace
  ON pos_garments (vendor_id, marketplace_garment_type_id) WHERE marketplace_garment_type_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pos_garments_vendor ON pos_garments (vendor_id, active);

CREATE TABLE IF NOT EXISTS pos_prices (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id              UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  garment_id             UUID NOT NULL REFERENCES pos_garments(id) ON DELETE CASCADE,
  service_id             UUID NOT NULL REFERENCES pos_services(id) ON DELETE CASCADE,
  customer_user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  rate_paise             INTEGER NOT NULL CHECK (rate_paise >= 0),
  active                 BOOLEAN NOT NULL DEFAULT true,
  source                 VARCHAR(12) NOT NULL DEFAULT 'POS' CHECK (source IN ('MARKETPLACE', 'POS')),
  marketplace_rate_id    UUID,
  marketplace_rate_paise INTEGER,
  price_overridden       BOOLEAN NOT NULL DEFAULT false,
  marketplace_missing    BOOLEAN NOT NULL DEFAULT false,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_prices_marketplace
  ON pos_prices (vendor_id, marketplace_rate_id) WHERE marketplace_rate_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_prices_pair
  ON pos_prices (vendor_id, garment_id, service_id, COALESCE(customer_user_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS idx_pos_prices_vendor ON pos_prices (vendor_id, active);

CREATE TABLE IF NOT EXISTS pos_tax_rules (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id  UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  name       VARCHAR(120) NOT NULL,
  rate_bps   INTEGER NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pos_tax_rules_vendor ON pos_tax_rules (vendor_id);

-- Garment tags for a POS-only garment have no marketplace garment_types row.
ALTER TABLE vendor_garment_units ALTER COLUMN garment_type_id DROP NOT NULL;
ALTER TABLE vendor_garment_units ADD COLUMN IF NOT EXISTS garment_name VARCHAR(160);
