-- Ola Maps integration settings — a single, dashboard-rotatable API key
-- (not an env var) so the key can be tested live and swapped without a
-- redeploy. Mirrors the sibling Bakaloo product's design.
CREATE TABLE IF NOT EXISTS ola_maps_settings (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  api_key            TEXT NULL,
  is_enabled         BOOLEAN NOT NULL DEFAULT false,
  last_tested_at     TIMESTAMPTZ NULL,
  last_test_status   VARCHAR(10) CHECK (last_test_status IN ('SUCCESS', 'FAILED')),
  last_test_message  TEXT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Forces exactly one row — this is a global singleton, not a per-vendor
-- or per-user setting.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ola_maps_settings_singleton ON ola_maps_settings ((1));
