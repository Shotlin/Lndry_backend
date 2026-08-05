-- Admin-curated customer segments (Phase 1 of the Bakaloo-ported growth/
-- marketing feature set — see CLAUDE.md's "Bakaloo Feature Port" section).
-- Manually-curated membership, not a dynamic rule/query builder — an admin
-- explicitly adds/removes user_ids. A user can belong to multiple segments.
-- Consumed by coupon targeting (Phase 2) via customer_segment_members.

CREATE TABLE IF NOT EXISTS customer_segments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_segment_members (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  segment_id UUID NOT NULL REFERENCES customer_segments(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by   UUID REFERENCES users(id),
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(segment_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_segment_members_user ON customer_segment_members(user_id);
CREATE INDEX IF NOT EXISTS idx_segment_members_segment ON customer_segment_members(segment_id);
