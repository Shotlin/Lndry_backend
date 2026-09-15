-- 102_rider_assignment_settings.sql
--
-- Phase 5 of the rider-assignment initiative (see CLAUDE.md). A single
-- GLOBAL row (same one-row-config pattern as fee_settings) holding the
-- admin-tunable broadcast re-timeout duration — previously hardcoded as
-- BROADCAST_TIMEOUT_MS in vendor-orders.service.js (Phase 4). Kept as its
-- own small dedicated table rather than folded into fee_settings (wrong
-- domain) or the generic app_settings key-value store (already flagged
-- as mostly-dead/undiscoverable config — see the Fees page work) so this
-- can grow its own genuinely-used settings page, same as Fees did.
--
-- broadcast_timeout_minutes: how long a broadcast offer stays open
-- before VendorOrdersService#rebroadcastIfStillOffered re-broadcasts it.
-- Room to grow: a future phase's "algorithm choice" (e.g. least-busy vs.
-- broadcast-only vs. round-robin) belongs on this same row.

CREATE TABLE IF NOT EXISTS rider_assignment_settings (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  broadcast_timeout_minutes   INTEGER NOT NULL DEFAULT 15
                              CONSTRAINT chk_ras_timeout_minutes CHECK (broadcast_timeout_minutes > 0 AND broadcast_timeout_minutes <= 1440),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by                  UUID NULL REFERENCES users(id) ON DELETE SET NULL
);

-- Exactly one row, ever — mirrors fee_settings' uq_fee_settings_global.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rider_assignment_settings_singleton
  ON rider_assignment_settings ((1));

INSERT INTO rider_assignment_settings (broadcast_timeout_minutes)
SELECT 15
WHERE NOT EXISTS (SELECT 1 FROM rider_assignment_settings);
