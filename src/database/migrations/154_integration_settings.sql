-- 154_integration_settings.sql
--
-- Dashboard-managed credentials for Razorpay (separate TEST and LIVE key sets
-- plus an "active mode" switch) and 2Factor.in SMS OTP. Like ola_maps_settings
-- (099) these replace fixed env vars so keys can be added, tested, swapped and
-- removed from Admin Dashboard -> Settings without a redeploy. Secrets are
-- stored AES-256-GCM encrypted (utils/secret-box.js); key ids (public) are
-- stored as plain text. When no dashboard value exists the runtime falls back
-- to the old env vars, so deploying this changes nothing by itself.

CREATE TABLE IF NOT EXISTS razorpay_settings (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  active_mode              VARCHAR(4) NOT NULL DEFAULT 'TEST' CHECK (active_mode IN ('TEST', 'LIVE')),

  test_key_id              TEXT NULL,
  test_key_secret_enc      TEXT NULL,
  test_webhook_secret_enc  TEXT NULL,
  test_last_tested_at      TIMESTAMPTZ NULL,
  test_last_status         VARCHAR(10) CHECK (test_last_status IN ('SUCCESS', 'FAILED')),
  test_last_message        TEXT NULL,

  live_key_id              TEXT NULL,
  live_key_secret_enc      TEXT NULL,
  live_webhook_secret_enc  TEXT NULL,
  live_last_tested_at      TIMESTAMPTZ NULL,
  live_last_status         VARCHAR(10) CHECK (live_last_status IN ('SUCCESS', 'FAILED')),
  live_last_message        TEXT NULL,

  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by               UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_razorpay_settings_singleton ON razorpay_settings ((1));

CREATE TABLE IF NOT EXISTS two_factor_settings (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  api_key_enc        TEXT NULL,
  template           VARCHAR(100) NOT NULL DEFAULT 'LndryAppOTP',
  is_enabled         BOOLEAN NOT NULL DEFAULT false,
  last_tested_at     TIMESTAMPTZ NULL,
  last_test_status   VARCHAR(10) CHECK (last_test_status IN ('SUCCESS', 'FAILED')),
  last_test_message  TEXT NULL,
  last_balance       VARCHAR(40) NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_two_factor_settings_singleton ON two_factor_settings ((1));
