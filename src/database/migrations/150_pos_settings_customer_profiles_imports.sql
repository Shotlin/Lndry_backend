-- 150_pos_settings_customer_profiles_imports.sql
--
-- Server-side storage for things the counter website used to keep only in the
-- browser, plus vendor-private customer details and bulk-import history.
-- Purely additive: four new tables, no existing table or column is touched.
--
-- 1. vendor_pos_settings — one JSON document per (vendor, setting). Service
--    units, order-number series, message templates, service zones, store
--    packages, print/tag preferences, UPI QR and route runs. `version` is bumped
--    on every save so two computers saving at once are detected instead of one
--    silently overwriting the other.
-- 2. vendor_customer_profiles / vendor_customer_addresses — what THIS vendor
--    knows about a customer (display name, e-mail, notes, addresses). Kept in
--    the vendor's own space on purpose: the counter must never rewrite the
--    shared LNDRY account (users / addresses) of someone who also uses the app,
--    and a Standard vendor must not see data other vendors or the person put on
--    that account.
-- 3. vendor_import_jobs — history of spreadsheet imports (prices / customers).

CREATE TABLE IF NOT EXISTS vendor_pos_settings (
  vendor_id   UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  setting_key VARCHAR(60) NOT NULL,
  value       JSONB NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (vendor_id, setting_key)
);

CREATE TABLE IF NOT EXISTS vendor_customer_profiles (
  vendor_id        UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  customer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name     VARCHAR(100),
  email            VARCHAR(160),
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (vendor_id, customer_user_id)
);

CREATE TABLE IF NOT EXISTS vendor_customer_addresses (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id        UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  customer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label            VARCHAR(50) NOT NULL DEFAULT 'Home',
  address_line1    VARCHAR(255) NOT NULL,
  address_line2    VARCHAR(255),
  landmark         VARCHAR(255),
  city             VARCHAR(100),
  state            VARCHAR(100),
  pincode          VARCHAR(10),
  is_default       BOOLEAN NOT NULL DEFAULT false,
  archived         BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vendor_customer_addresses_customer
  ON vendor_customer_addresses (vendor_id, customer_user_id) WHERE archived = false;

CREATE TABLE IF NOT EXISTS vendor_import_jobs (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id    UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  import_type  VARCHAR(20) NOT NULL CHECK (import_type IN ('customers', 'prices')),
  status       VARCHAR(20) NOT NULL DEFAULT 'COMPLETED',
  total_rows   INTEGER NOT NULL DEFAULT 0,
  created_rows INTEGER NOT NULL DEFAULT 0,
  updated_rows INTEGER NOT NULL DEFAULT 0,
  skipped_rows INTEGER NOT NULL DEFAULT 0,
  errors       JSONB NOT NULL DEFAULT '[]'::jsonb,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_name   VARCHAR(120),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vendor_import_jobs_vendor
  ON vendor_import_jobs (vendor_id, import_type, completed_at DESC);
