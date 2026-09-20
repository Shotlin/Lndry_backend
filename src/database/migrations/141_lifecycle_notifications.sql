-- ═══════════════════════════════════════════════════════════════════════════
-- 141: Order lifecycle notifications
--   notification_event_templates : admin overrides of the built-in lifecycle
--       messages (the defaults live in code, so nothing is needed here until
--       someone edits a message; deleting a row restores the default)
--   notification_events          : one row per (event, recipient, dedupe key) —
--       the idempotency guard (a retry, refresh or webhook replay can never send
--       the same lifecycle notification twice) AND the audit trail shown in the
--       dashboard (status, devices reached, opens).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS notification_event_templates (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_key        VARCHAR(60) NOT NULL UNIQUE,
  recipient_type   VARCHAR(20) NOT NULL
                     CHECK (recipient_type IN ('CUSTOMER', 'VENDOR', 'CAPTAIN')),
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  deep_link_type   VARCHAR(40),
  deep_link_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  image_url        TEXT,
  updated_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_events (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_key         VARCHAR(60) NOT NULL,
  recipient_type    VARCHAR(20) NOT NULL,
  order_id          UUID REFERENCES orders(id) ON DELETE SET NULL,
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dedupe_key        TEXT NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING', 'SENT', 'PARTIAL', 'FAILED', 'NO_DEVICE', 'SKIPPED')),
  skip_reason       VARCHAR(60),
  title             TEXT,          -- rendered text with any OTP masked
  body              TEXT,
  notification_id   UUID REFERENCES notifications(id) ON DELETE SET NULL,
  devices_total     INTEGER NOT NULL DEFAULT 0,
  devices_sent      INTEGER NOT NULL DEFAULT 0,
  devices_failed    INTEGER NOT NULL DEFAULT 0,
  error_summary     TEXT,
  attempts          INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at           TIMESTAMPTZ,
  -- Per ORDER as well: the same customer's next order must not look like a repeat of the last one.
  CONSTRAINT uq_notification_event UNIQUE (event_key, recipient_type, recipient_user_id, order_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_ne_order   ON notification_events(order_id);
CREATE INDEX IF NOT EXISTS idx_ne_created ON notification_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ne_status  ON notification_events(status);
