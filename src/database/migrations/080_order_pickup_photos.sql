-- Garment condition photos captured by a rider at pickup, for
-- damage-dispute protection. A row with order_line_id NULL + is_grouped
-- true is the single shared photo covering all weight(kg)-priced lines on
-- the order; a row with order_line_id set + is_grouped false is the
-- dedicated photo for one piece-priced line. Distinct from the existing
-- single-photo proof_photo_url columns, which belong to the unrelated
-- legacy delivery-proof flow.
CREATE TABLE IF NOT EXISTS order_pickup_photos (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_line_id UUID NULL REFERENCES order_lines(id) ON DELETE SET NULL,
  photo_url     TEXT NOT NULL,
  is_grouped    BOOLEAN NOT NULL DEFAULT false,
  uploaded_by   UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_pickup_photos_order ON order_pickup_photos(order_id);
