-- ═══════════════════════════════════════════════════════════════════════════
-- 140: Production notification platform
--   * fcm_tokens becomes a real device registry (multi-device, app type, role,
--     device id, last activity, logout tracking)
--   * notification_campaigns stores the audience spec + deep link so a
--     SCHEDULED campaign is sent to exactly the audience chosen (it used to
--     lose its segment value and widen to every user)
--   * notification_deliveries: one row per message actually handed to FCM,
--     the source of sent / failed / opened statistics
--   * DRAFT campaign status; deep-link preset columns on templates
-- All changes are additive / relaxing; nothing existing is dropped.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Device registry ─────────────────────────────────────────────────────
ALTER TABLE fcm_tokens
  ADD COLUMN IF NOT EXISTS app_type       VARCHAR(20),
  ADD COLUMN IF NOT EXISTS user_role      VARCHAR(30),
  ADD COLUMN IF NOT EXISTS device_id      VARCHAR(120),
  ADD COLUMN IF NOT EXISTS device_model   VARCHAR(120),
  ADD COLUMN IF NOT EXISTS app_version    VARCHAR(40),
  ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS logged_out_at  TIMESTAMPTZ;

ALTER TABLE fcm_tokens DROP CONSTRAINT IF EXISTS chk_fcm_tokens_app_type;
ALTER TABLE fcm_tokens ADD CONSTRAINT chk_fcm_tokens_app_type
  CHECK (app_type IS NULL OR app_type IN ('customer', 'partner'));

-- Existing tokens: a person who works for a vendor registered from the
-- Partner app, everyone else from the customer app.
UPDATE fcm_tokens t
   SET app_type = CASE
         WHEN EXISTS (
           SELECT 1 FROM vendor_employees ve
            WHERE ve.user_id = t.user_id AND ve.is_active AND ve.deleted_at IS NULL
         ) THEN 'partner' ELSE 'customer' END
 WHERE t.app_type IS NULL;

UPDATE fcm_tokens t
   SET user_role = u.role
  FROM users u
 WHERE u.id = t.user_id AND t.user_role IS NULL;

CREATE INDEX IF NOT EXISTS idx_fcm_tokens_user_device
  ON fcm_tokens(user_id, device_id) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fcm_tokens_app_active
  ON fcm_tokens(app_type) WHERE is_active = true;

-- ── 2. Campaigns: audience + deep link, DRAFT status ───────────────────────
ALTER TABLE notification_campaigns
  ADD COLUMN IF NOT EXISTS audience         JSONB,
  ADD COLUMN IF NOT EXISTS target_app       VARCHAR(20),
  ADD COLUMN IF NOT EXISTS deep_link_type   VARCHAR(40),
  ADD COLUMN IF NOT EXISTS deep_link_params JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS segment_value    TEXT,
  ADD COLUMN IF NOT EXISTS device_count     INTEGER DEFAULT 0;

-- The status / target_type CHECKs are closed lists; replace them with ones
-- that allow DRAFT and the new audience kinds. Found by definition so the
-- automatically generated constraint names don't matter.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'notification_campaigns'::regclass
       AND contype = 'c'
       AND (pg_get_constraintdef(oid) ILIKE '%QUEUED%'
            OR pg_get_constraintdef(oid) ILIKE '%no_order_7_days%')
  LOOP
    EXECUTE format('ALTER TABLE notification_campaigns DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE notification_campaigns ADD CONSTRAINT chk_nc_status
  CHECK (status IN ('DRAFT', 'QUEUED', 'SENDING', 'SENT', 'FAILED', 'SCHEDULED', 'CANCELLED'));

-- ── 3. Templates: optional deep-link preset ────────────────────────────────
ALTER TABLE notification_templates
  ADD COLUMN IF NOT EXISTS deep_link_type   VARCHAR(40),
  ADD COLUMN IF NOT EXISTS deep_link_params JSONB DEFAULT '{}'::jsonb;

-- ── 4. Per-message delivery log ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id     UUID REFERENCES notification_campaigns(id) ON DELETE CASCADE,
  notification_id UUID REFERENCES notifications(id) ON DELETE SET NULL,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id        UUID REFERENCES fcm_tokens(id) ON DELETE SET NULL,
  app_type        VARCHAR(20),
  kind            VARCHAR(20) NOT NULL DEFAULT 'CAMPAIGN',   -- CAMPAIGN | TRANSACTIONAL | TEST
  status          VARCHAR(20) NOT NULL
                    CHECK (status IN ('SENT', 'FAILED', 'INVALID_TOKEN')),
  fcm_message_id  TEXT,
  error_code      VARCHAR(120),
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_nd_campaign ON notification_deliveries(campaign_id);
CREATE INDEX IF NOT EXISTS idx_nd_user     ON notification_deliveries(user_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_nd_notif    ON notification_deliveries(notification_id)
  WHERE notification_id IS NOT NULL;
