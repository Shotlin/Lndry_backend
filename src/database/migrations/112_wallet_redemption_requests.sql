-- 112_wallet_redemption_requests.sql
--
-- POS-counter wallet redemption: a vendor looks up a customer by phone,
-- proposes redeeming some of their real LNDRY wallet balance against the
-- sale, and the customer confirms by reading a one-time code off their own
-- already-logged-in app (see order_otps for the closest existing
-- precedent — hash stored here, plaintext stashed in Redis for the
-- code-holder's own app to fetch, a different actor submits it to confirm
-- a real-world action).
--
-- Two deliberate departures from order_otps: (a) one `status` enum instead
-- of order_otps' redundant consumed_at/used_at pair; (b) the partial
-- unique index below creates a self-inflicted lazy-expiry gap order_otps
-- doesn't have (a stale un-decided PENDING row would otherwise permanently
-- block that customer from a new request, since a partial index can't
-- reference NOW()) — solved application-side: the create-request path
-- sweeps this customer's own stale PENDING rows to EXPIRED immediately
-- before inserting, no new worker needed.

CREATE TABLE IF NOT EXISTS wallet_redemption_requests (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vendor_id             UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  requested_by_user_id  UUID NOT NULL REFERENCES users(id),
  amount_paise          INTEGER NOT NULL CHECK (amount_paise > 0),
  otp_hash              VARCHAR(200) NOT NULL,
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  status                VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                           CHECK (status IN ('PENDING','CONFIRMED','REJECTED','EXPIRED','CANCELLED')),
  wallet_transaction_id UUID REFERENCES wallet_transactions(id),
  expires_at            TIMESTAMPTZ NOT NULL,
  confirmed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one PENDING request per customer, globally (not per-vendor) —
-- a customer standing at one counter can't simultaneously have a second
-- redemption in flight at another.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_redemption_one_pending_per_customer
  ON wallet_redemption_requests(customer_user_id) WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_wallet_redemption_customer_status
  ON wallet_redemption_requests(customer_user_id, status);
CREATE INDEX IF NOT EXISTS idx_wallet_redemption_vendor_status
  ON wallet_redemption_requests(vendor_id, status);
