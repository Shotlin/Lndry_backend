-- 031_shop_products.sql
-- Create vendor_services table for per-shop inventory and pricing
-- Supports stock tracking, pricing overrides, low-stock alerts, sold-out detection

-- ═══════════════════════════════════════════════════════════════
-- 1. SHOP_PRODUCTS TABLE
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vendor_services (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Relationships
  vendor_id               UUID NOT NULL REFERENCES vendors(id),
  garment_rate_id            UUID NOT NULL REFERENCES garment_rates(id),

  -- Pricing (NULL price means inherit from garment_rates table)
  price                 DECIMAL(10,2)
                        CONSTRAINT chk_shop_products_price CHECK (price IS NULL OR (price >= 0.01 AND price <= 99999999.99)),
  sale_price            DECIMAL(10,2)
                        CONSTRAINT chk_shop_products_sale_price CHECK (sale_price IS NULL OR (sale_price >= 0.01 AND sale_price <= 99999999.99)),
  cost_price            DECIMAL(10,2)
                        CONSTRAINT chk_shop_products_cost_price CHECK (cost_price IS NULL OR (cost_price >= 0.00 AND cost_price <= 99999999.99)),

  -- Inventory
  stock_quantity        INTEGER NOT NULL DEFAULT 0
                        CONSTRAINT chk_shop_products_stock_quantity CHECK (stock_quantity >= 0),
  low_stock_threshold   INTEGER NOT NULL DEFAULT 5
                        CONSTRAINT chk_shop_products_low_stock_threshold CHECK (low_stock_threshold >= 0),
  max_order_qty         INTEGER NOT NULL DEFAULT 50
                        CONSTRAINT chk_shop_products_max_order_qty CHECK (max_order_qty >= 1 AND max_order_qty <= 10000),

  -- Availability
  is_available          BOOLEAN DEFAULT true,
  sold_out_at           TIMESTAMPTZ NULL,

  -- Soft Delete
  deleted_at            TIMESTAMPTZ NULL,

  -- Timestamps
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),

  -- Constraints
  CONSTRAINT uq_shop_products_shop_product UNIQUE (vendor_id, garment_rate_id)
);

-- ═══════════════════════════════════════════════════════════════
-- 2. INDEXES
-- ═══════════════════════════════════════════════════════════════

-- Partial index for active listings (excludes soft-deleted)
CREATE INDEX IF NOT EXISTS idx_shop_products_shop_available
  ON vendor_services (vendor_id, is_available)
  WHERE deleted_at IS NULL;

-- Product lookup (find all vendors carrying a product)
CREATE INDEX IF NOT EXISTS idx_shop_products_product_id
  ON vendor_services (garment_rate_id);

-- Low stock alerts (partial index using literal threshold for IMMUTABLE compliance)
CREATE INDEX IF NOT EXISTS idx_shop_products_low_stock
  ON vendor_services (vendor_id)
  WHERE stock_quantity <= 5;
