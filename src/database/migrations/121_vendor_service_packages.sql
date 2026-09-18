-- 121_vendor_service_packages.sql
--
-- Prepaid service packages ("buy N washes upfront, redeem later"), ported
-- from epic-laundry-desktop's packages.ts. Four tables, mirroring epic's own
-- four entities (service_package/package_service/customer_package/
-- package_redemption) plus a payments table for partial-pay purchases
-- (epic's customer_package_payment).
--
-- Each package line references vendor_service_rates directly (a vendor's
-- real garment+service+price combo, migration 062) rather than separate
-- garment_type_id/vendor_service_id columns — that pairing already exists
-- as one row in this backend's real catalogue, unlike epic's own schema
-- where garment and service are separate local tables with no combined row.
--
-- Purchases/payments post to vendor_customer_ledger (migration 115, shipped
-- in Tier 0) instead of a new ledger mechanism — reusing real,
-- already-shipped infrastructure exactly like epic's own
-- purchaseServicePackage/collectServicePackagePayment call the shared
-- appendCustomerLedger.

CREATE TABLE IF NOT EXISTS vendor_service_packages (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id      UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  name           VARCHAR(160) NOT NULL,
  description    VARCHAR(1200),
  price_paise    INTEGER NOT NULL CHECK (price_paise >= 0),
  validity_days  INTEGER NOT NULL CHECK (validity_days BETWEEN 1 AND 3650),
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_service_packages_name
  ON vendor_service_packages (vendor_id, lower(name));

CREATE TABLE IF NOT EXISTS vendor_service_package_lines (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  package_id            UUID NOT NULL REFERENCES vendor_service_packages(id) ON DELETE CASCADE,
  vendor_service_rate_id UUID NOT NULL REFERENCES vendor_service_rates(id) ON DELETE CASCADE,
  allowance             NUMERIC(10,2) NOT NULL CHECK (allowance > 0),
  CONSTRAINT uq_vendor_service_package_lines UNIQUE (package_id, vendor_service_rate_id)
);

CREATE TABLE IF NOT EXISTS vendor_customer_packages (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id            UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  package_id           UUID NOT NULL REFERENCES vendor_service_packages(id),
  customer_user_id     UUID NOT NULL REFERENCES users(id),
  purchased_date       DATE NOT NULL,
  expires_on           DATE NOT NULL,
  contract_price_paise INTEGER NOT NULL CHECK (contract_price_paise >= 0),
  price_paid_paise     INTEGER NOT NULL DEFAULT 0 CHECK (price_paid_paise >= 0),
  payment_mode         VARCHAR(12) NOT NULL DEFAULT 'PAY_LATER'
                        CHECK (payment_mode IN ('PAY_LATER', 'CASH', 'UPI', 'CARD', 'BANK')),
  payment_status       VARCHAR(10) NOT NULL DEFAULT 'UNPAID'
                        CHECK (payment_status IN ('UNPAID', 'PART_PAID', 'PAID')),
  status               VARCHAR(10) NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE', 'EXHAUSTED', 'EXPIRED', 'CANCELLED')),
  created_by           UUID NOT NULL REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vendor_customer_packages_customer
  ON vendor_customer_packages(vendor_id, customer_user_id, purchased_date DESC);

CREATE TABLE IF NOT EXISTS vendor_customer_package_payments (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_package_id UUID NOT NULL REFERENCES vendor_customer_packages(id) ON DELETE CASCADE,
  amount_paise        INTEGER NOT NULL CHECK (amount_paise > 0),
  mode                VARCHAR(10) NOT NULL CHECK (mode IN ('CASH', 'UPI', 'CARD', 'BANK')),
  reference            VARCHAR(120),
  payment_date        DATE NOT NULL,
  reason              VARCHAR(500),
  created_by          UUID NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vendor_package_redemptions (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_package_id    UUID NOT NULL REFERENCES vendor_customer_packages(id) ON DELETE CASCADE,
  vendor_service_rate_id UUID NOT NULL REFERENCES vendor_service_rates(id),
  quantity               NUMERIC(10,2) NOT NULL CHECK (quantity > 0),
  redeemed_date          DATE NOT NULL,
  order_id               UUID REFERENCES orders(id) ON DELETE SET NULL,
  reason                 VARCHAR(500),
  created_by             UUID NOT NULL REFERENCES users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vendor_package_redemptions_package
  ON vendor_package_redemptions(customer_package_id);
