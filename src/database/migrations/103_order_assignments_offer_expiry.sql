-- 103_order_assignments_offer_expiry.sql
--
-- Phase 6 of the rider-assignment initiative (see CLAUDE.md). Persists
-- when a broadcast offer expires (computed at broadcast time from the
-- Phase 5 rider_assignment_settings.broadcast_timeout_minutes that was
-- in effect then) so the rider app can show an accurate live countdown
-- even if it missed the original `job:offered` socket event (app closed,
-- briefly disconnected, etc.) — GET /vendor/rider/offers exposes this
-- column so the app can recover the correct remaining time on reconnect,
-- not just trust whatever the socket payload said in the moment.
--
-- NULL for a targeted offer (Phase 2's offerToEmployee) — those have no
-- timeout/re-broadcast mechanism, only broadcast offers do.

ALTER TABLE order_assignments ADD COLUMN IF NOT EXISTS offer_expires_at TIMESTAMPTZ NULL;
