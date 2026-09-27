-- Self-hosted APK distribution for the two Flutter apps (customer "LNDRY"
-- and vendor "Lndry Partner"), used before either is live on Play Store.
-- An admin uploads a build from the dashboard; the public website's
-- download buttons and this table's public read endpoints always serve
-- whichever row is currently `is_active` for that app — a lightweight,
-- self-hosted stand-in for what Play Console's "rollout" does.
--
-- The APK file itself is NOT stored in Postgres (100MB+ blobs don't belong
-- in bytea columns the way the much smaller invoice PDFs are) — it's
-- written to the already-persisted `storage/documents` volume (see
-- uploads.controller.js#uploadDocumentPrivate for the precedent), under a
-- new `app-releases/` subdirectory. This row is metadata + the on-disk
-- filename only.
CREATE TABLE IF NOT EXISTS app_releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app VARCHAR(10) NOT NULL CHECK (app IN ('CUSTOMER', 'VENDOR')),
  version_name VARCHAR(50) NOT NULL,
  version_code INTEGER NOT NULL,
  release_notes TEXT,
  file_name VARCHAR(100) NOT NULL,
  original_file_name VARCHAR(255) NOT NULL,
  file_size_bytes BIGINT NOT NULL,
  sha256 VARCHAR(64) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Exactly one active (currently-served) release per app at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_releases_active_app
  ON app_releases (app)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_app_releases_app_created
  ON app_releases (app, created_at DESC);
