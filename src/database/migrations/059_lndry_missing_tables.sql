-- Migration 059: Create LNDRY specific tables and columns
CREATE TABLE IF NOT EXISTS devices (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    VARCHAR(255) NOT NULL,
  platform     VARCHAR(50) NOT NULL,
  fcm_token    TEXT NOT NULL,
  app_version  VARCHAR(50),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_user_device UNIQUE (user_id, device_id)
);

CREATE TABLE IF NOT EXISTS otp_challenges (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone         VARCHAR(15) NOT NULL,
  otp_hash      VARCHAR(255) NOT NULL,
  account_type  VARCHAR(50) NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  attempts      INT DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_drafts (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vendor_id           UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  slot_id             UUID NOT NULL REFERENCES vendor_slots(id) ON DELETE CASCADE,
  address_id          UUID NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  garment_lines       JSONB NOT NULL,
  estimated_weight    DECIMAL(10,2),
  payable_amount_paise INTEGER NOT NULL,
  snapshot            JSONB NOT NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_garment_lines (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  garment_rate_id UUID NOT NULL REFERENCES garment_rates(id) ON DELETE CASCADE,
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  rate_paise      INTEGER NOT NULL,
  total_paise     INTEGER NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID REFERENCES orders(id) ON DELETE CASCADE NOT NULL,
  old_status  VARCHAR(50),
  new_status  VARCHAR(50) NOT NULL,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role  VARCHAR(50),
  note        TEXT,
  request_id  VARCHAR(100),
  timestamp   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS slot_exceptions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id   UUID REFERENCES vendors(id) ON DELETE CASCADE NOT NULL,
  date        DATE NOT NULL,
  type        VARCHAR(50) NOT NULL,
  limit_count INTEGER,
  reason      TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_vendor_date_exception UNIQUE (vendor_id, date)
);

CREATE TABLE IF NOT EXISTS watermark_jobs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  asset_id      VARCHAR(255) NOT NULL,
  status        VARCHAR(50) DEFAULT 'PENDING',
  error_message TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_settings (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key         VARCHAR(100) UNIQUE NOT NULL,
  value       JSONB NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS estimated_amount_paise INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payable_amount_paise INTEGER DEFAULT 0;
