-- 012_wishlist.sql
-- User wishlist for garment_rates

CREATE TABLE IF NOT EXISTS wishlist (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  garment_rate_id  UUID REFERENCES garment_rates(id) ON DELETE CASCADE NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_user_product ON wishlist(user_id, garment_rate_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_user ON wishlist(user_id);
