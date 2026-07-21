-- Migration 077: full support ticket lifecycle — admin reply, vendor
-- follow-up, and a satisfaction rating, plus a real status vocabulary.
--
-- Lifecycle: OPEN (default, on create) -> REPLIED (admin responds) ->
-- CLOSED (vendor confirms satisfied + rates, or admin closes directly).
-- A vendor follow-up on a REPLIED ticket reopens it to OPEN so admin knows
-- there's something new to address.

ALTER TABLE vendor_support_tickets
  ADD COLUMN IF NOT EXISTS admin_reply TEXT,
  ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS replied_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS vendor_reply TEXT,
  ADD COLUMN IF NOT EXISTS vendor_replied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rating SMALLINT,
  ADD COLUMN IF NOT EXISTS rated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_vst_status'
  ) THEN
    ALTER TABLE vendor_support_tickets
      ADD CONSTRAINT chk_vst_status CHECK (status IN ('OPEN', 'REPLIED', 'CLOSED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_vst_rating'
  ) THEN
    ALTER TABLE vendor_support_tickets
      ADD CONSTRAINT chk_vst_rating CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5));
  END IF;
END $$;
