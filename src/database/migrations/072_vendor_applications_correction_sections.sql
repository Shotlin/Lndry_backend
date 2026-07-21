-- Migration 072: Admin's "Request correction" action previously had no way to say
-- WHICH parts of the application need fixing, or why — it just flipped the status
-- to CORRECTION_REQUIRED with no reason attached, even though `rejection_reason`
-- already existed as a column (unused until now). Add `correction_sections` to
-- record which wizard steps were flagged (e.g. ["business","documents"]), so the
-- vendor app can lock every other step and only reopen the flagged ones.

ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS correction_sections JSONB;
