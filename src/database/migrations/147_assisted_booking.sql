-- "Not sure what to choose?" assisted booking (Book With Expert Check).
--
-- The customer books a pickup without choosing services; the vendor inspects
-- the garments and picks services/quantities/weight through the EXISTING
-- re-evaluation flow, the customer approves, and the order carries on
-- normally. This migration only adds:
--   * booking_type on quotes / order_drafts / orders ('STANDARD' | 'ASSISTED'),
--   * the admin-controlled settings + optional per-vendor selection.
-- No pricing or re-evaluation table is duplicated.

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['quotes', 'order_drafts', 'orders'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = t AND column_name = 'booking_type'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN booking_type TEXT NOT NULL DEFAULT ''STANDARD''', t);
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (booking_type IN (''STANDARD'', ''ASSISTED''))',
        t, t || '_booking_type_check'
      );
    END IF;
  END LOOP;
END $$;

-- One GLOBAL row, same one-row-config pattern as rider_assignment_settings.
CREATE TABLE IF NOT EXISTS assisted_booking_settings (
  id                 TEXT PRIMARY KEY DEFAULT 'GLOBAL' CHECK (id = 'GLOBAL'),
  -- OFF until an admin turns it on: nothing changes for customers on deploy.
  enabled            BOOLEAN NOT NULL DEFAULT false,
  -- ALL = every marketplace vendor; SELECTED = only vendors in
  -- assisted_booking_vendors.
  scope              TEXT NOT NULL DEFAULT 'ALL' CHECK (scope IN ('ALL', 'SELECTED')),
  title              TEXT NOT NULL DEFAULT 'Not sure what service you need?',
  subtitle           TEXT NOT NULL DEFAULT 'Book now — we''ll inspect your garments and confirm the right service & price.',
  button_text        TEXT NOT NULL DEFAULT 'Book With Expert Check',
  icon_url           TEXT,
  checkout_note      TEXT NOT NULL DEFAULT 'Service & final price will be confirmed after garment inspection.',
  assessment_title   TEXT NOT NULL DEFAULT 'Laundry Assessment Required',
  assessment_message TEXT NOT NULL DEFAULT 'Vendor will inspect your garments and confirm services, quantity/weight and final price.',
  price_label        TEXT NOT NULL DEFAULT 'Price after inspection',
  updated_by         UUID,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO assisted_booking_settings (id) VALUES ('GLOBAL') ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS assisted_booking_vendors (
  vendor_id  UUID PRIMARY KEY REFERENCES vendors(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_booking_type
  ON orders (vendor_id, status) WHERE booking_type = 'ASSISTED';
