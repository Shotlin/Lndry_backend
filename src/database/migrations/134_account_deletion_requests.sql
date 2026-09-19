-- 134_account_deletion_requests.sql
-- Customer "Delete Account" workflow:
--   customer requests (PENDING) -> admin approves (APPROVED, 30-day grace
--   period starts, account deactivated) or rejects (REJECTED, account stays
--   active) -> after scheduled_deletion_at the worker anonymizes the account
--   (COMPLETED).
--
-- Deletion means ANONYMIZATION, not a row delete: orders, payments, invoices
-- and audit trails reference users(id) from ~50 tables and must survive for
-- accounting. Personal data (name, phone, email, avatar, addresses, device
-- tokens, notifications, wishlist) is scrubbed instead — see
-- src/workers/account-deletion.worker.js.

CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               UUID NOT NULL REFERENCES users(id),
  status                VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'COMPLETED')),
  reason                TEXT,
  requested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Admin decision
  reviewed_at           TIMESTAMPTZ,
  reviewed_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  review_note           TEXT,

  -- Grace period / final deletion
  scheduled_deletion_at TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,

  -- Who the request belonged to, so the admin list stays readable after the
  -- user row is anonymized. Scrubbed (name -> NULL, phone -> masked) when the
  -- request reaches COMPLETED so the request table doesn't retain the PII the
  -- deletion is meant to remove.
  customer_name         VARCHAR(100),
  customer_phone        VARCHAR(20),

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A customer can only have one live request at a time (PENDING or waiting out
-- the grace period). DB-enforced so a double-tap race can't create two.
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_deletion_open_per_user
  ON account_deletion_requests (user_id)
  WHERE status IN ('PENDING', 'APPROVED');

CREATE INDEX IF NOT EXISTS idx_account_deletion_status
  ON account_deletion_requests (status, requested_at DESC);

-- Worker lookup: approved requests whose grace period has ended.
CREATE INDEX IF NOT EXISTS idx_account_deletion_due
  ON account_deletion_requests (scheduled_deletion_at)
  WHERE status = 'APPROVED';

-- On the user row: lets login say "scheduled for deletion" instead of the
-- generic "blocked" message, and marks accounts that are already anonymized.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;
