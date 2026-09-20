-- 145_store_order_status_events.sql
--
-- The status history of a counter order (Booked → In Process → Ready → …, or Cancelled), one row per
-- change, written in the SAME statement that changes the status — so the timeline can never disagree
-- with the order. Orders booked before this table exist simply have no rows (their timeline starts at
-- the booking); every change from now on is recorded.

CREATE TABLE IF NOT EXISTS store_order_status_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_order_id  UUID NOT NULL REFERENCES store_orders(id) ON DELETE CASCADE,
  vendor_id       UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  from_status     VARCHAR(30),
  to_status       VARCHAR(30) NOT NULL,
  actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  note            VARCHAR(500),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_store_order_status_events_order ON store_order_status_events (store_order_id, created_at);
