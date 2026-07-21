-- Migration 068: Vendor Support Tickets
-- Creates the vendor_support_tickets table for the Help & Support Tickets feature.

CREATE TABLE IF NOT EXISTS vendor_support_tickets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id       UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_ref      TEXT NOT NULL UNIQUE,           -- Human-readable TKT-XXXXXX
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'Other',  -- Order Issue, Payout, Technical, Account, Other
  status          TEXT NOT NULL DEFAULT 'OPEN',   -- OPEN, IN_PROGRESS, RESOLVED, CLOSED
  priority        TEXT NOT NULL DEFAULT 'NORMAL', -- LOW, NORMAL, HIGH, URGENT
  admin_notes     TEXT,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vst_vendor_id
  ON vendor_support_tickets (vendor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vst_user_id
  ON vendor_support_tickets (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vst_status
  ON vendor_support_tickets (status);

-- Sequence for human-readable ticket reference (TKT-1001, TKT-1002, ...)
CREATE SEQUENCE IF NOT EXISTS vendor_ticket_ref_seq START 1001;

COMMENT ON TABLE vendor_support_tickets IS
  'Support tickets submitted by vendors via the Help & Support page.';
