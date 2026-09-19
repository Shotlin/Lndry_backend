-- 130_counter_work_orders.sql
--
-- Makes a counter (walk-in) order a real work order, so the counter/POS
-- surface built in migrations 114-129 (garment tags, production queue,
-- quality claims, returns, payments) can operate on it — not only on the
-- pickup-delivery `orders` table.
--
-- store_orders (migration 111) started life as an already-complete sale
-- record pushed by the desktop app. It stays exactly that for every existing
-- row (status DELIVERED, fully paid — the defaults below), and gains the
-- lifecycle a counter drop-off actually has: booked -> in process -> ready ->
-- out for delivery -> delivered, with expected-delivery, riders, notes, and
-- partial/later payment. New counter sales use source 'COUNTER'.
--
-- Walk-in customers without a LNDRY account are represented as an ordinary
-- `users` row created by the vendor (phone + name only, no password — this
-- backend authenticates by OTP alone). If that person later signs up with the
-- same phone, the OTP login lands on the existing row, so their in-store
-- history is simply already there. No separate guest table, no re-linking.
--
-- The tables below referenced orders(id) for their order_id column. A counter
-- order lives in store_orders, so the same column now holds either kind of
-- work-order id (both are UUIDs); the services check existence in the right
-- table. The FK is dropped rather than duplicated as a second nullable column
-- per table — every one of these tables only ever needs "which work order".

ALTER TABLE store_orders
  ADD COLUMN IF NOT EXISTS status                     VARCHAR(20) NOT NULL DEFAULT 'DELIVERED'
    CHECK (status IN ('BOOKED', 'PICKED_UP', 'IN_PROCESS', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED')),
  ADD COLUMN IF NOT EXISTS version                    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source                     VARCHAR(20) NOT NULL DEFAULT 'DESKTOP_PUSH',
  ADD COLUMN IF NOT EXISTS order_date                 DATE,
  ADD COLUMN IF NOT EXISTS expected_delivery_date     DATE,
  ADD COLUMN IF NOT EXISTS fulfillment_mode           VARCHAR(30),
  ADD COLUMN IF NOT EXISTS delivery_address           TEXT,
  ADD COLUMN IF NOT EXISTS service_zone               VARCHAR(120),
  ADD COLUMN IF NOT EXISTS notes                      VARCHAR(1000),
  ADD COLUMN IF NOT EXISTS photo_path                 TEXT,
  ADD COLUMN IF NOT EXISTS charges_paise              INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_rate_bps               INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_paid_paise          INTEGER,
  ADD COLUMN IF NOT EXISTS payment_reference          VARCHAR(120),
  ADD COLUMN IF NOT EXISTS cancel_reason              VARCHAR(500),
  ADD COLUMN IF NOT EXISTS pickup_rider_employee_id   UUID REFERENCES vendor_employees(id),
  ADD COLUMN IF NOT EXISTS delivery_rider_employee_id UUID REFERENCES vendor_employees(id),
  ADD COLUMN IF NOT EXISTS updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Every pre-existing row was a finished, fully paid sale.
UPDATE store_orders SET amount_paid_paise = total_paise WHERE amount_paid_paise IS NULL;
ALTER TABLE store_orders ALTER COLUMN amount_paid_paise SET NOT NULL;
ALTER TABLE store_orders ALTER COLUMN amount_paid_paise SET DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_store_orders_status ON store_orders(vendor_id, status, placed_at DESC);

CREATE TABLE IF NOT EXISTS store_order_payments (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_order_id UUID NOT NULL REFERENCES store_orders(id) ON DELETE CASCADE,
  vendor_id      UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  amount_paise   INTEGER NOT NULL CHECK (amount_paise > 0),
  mode           VARCHAR(10) NOT NULL CHECK (mode IN ('CASH', 'UPI', 'CARD', 'BANK', 'WALLET')),
  reference      VARCHAR(120),
  cash_shift_id  UUID REFERENCES vendor_cash_shifts(id),
  created_by     UUID NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_store_order_payments_order ON store_order_payments(store_order_id);

-- Garment tags: a counter order has no order_lines row, so a unit is located
-- by (work order, line position, sequence) instead.
ALTER TABLE vendor_garment_units ALTER COLUMN order_line_id DROP NOT NULL;
ALTER TABLE vendor_garment_units ADD COLUMN IF NOT EXISTS store_line_index INTEGER;
ALTER TABLE vendor_garment_units DROP CONSTRAINT IF EXISTS vendor_garment_units_order_id_fkey;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_garment_units_store_line
  ON vendor_garment_units (order_id, store_line_index, sequence) WHERE store_line_index IS NOT NULL;

ALTER TABLE vendor_laundry_containers DROP CONSTRAINT IF EXISTS vendor_laundry_containers_order_id_fkey;
ALTER TABLE vendor_print_jobs         DROP CONSTRAINT IF EXISTS vendor_print_jobs_order_id_fkey;
ALTER TABLE vendor_production_tasks   DROP CONSTRAINT IF EXISTS vendor_production_tasks_order_id_fkey;
ALTER TABLE vendor_quality_claims     DROP CONSTRAINT IF EXISTS vendor_quality_claims_order_id_fkey;
ALTER TABLE vendor_customer_corrections DROP CONSTRAINT IF EXISTS vendor_customer_corrections_order_id_fkey;
ALTER TABLE vendor_return_cases       DROP CONSTRAINT IF EXISTS vendor_return_cases_order_id_fkey;
ALTER TABLE vendor_package_redemptions DROP CONSTRAINT IF EXISTS vendor_package_redemptions_order_id_fkey;
