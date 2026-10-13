-- 156_blog_system.sql
-- Blog for the public website (lndry.in/blog). Written from the admin dashboard
-- (Blog / Blog Categories pages) via /api/v1/admin/blog and read by the website
-- through the public /api/v1/blog endpoints. Full-text search and "trending"
-- are plain SQL here — no extensions or external services.

CREATE TABLE IF NOT EXISTS blog_categories (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 60),
  slug        TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 80),
  description TEXT CHECK (description IS NULL OR char_length(description) <= 300),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS blog_posts (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title            TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  slug             TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 120),
  excerpt          TEXT CHECK (excerpt IS NULL OR char_length(excerpt) <= 400),
  content_html     TEXT NOT NULL DEFAULT '',
  cover_image_url  TEXT CHECK (cover_image_url IS NULL OR cover_image_url ~ '^https://'),
  cover_image_alt  TEXT CHECK (cover_image_alt IS NULL OR char_length(cover_image_alt) <= 200),
  category_id      UUID REFERENCES blog_categories(id) ON DELETE SET NULL,
  tags             TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 12),
  author_name      TEXT NOT NULL DEFAULT 'LNDRY Team' CHECK (char_length(author_name) BETWEEN 2 AND 80),
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  published_at     TIMESTAMPTZ,
  is_featured      BOOLEAN NOT NULL DEFAULT false,
  -- SEO
  focus_keyword    TEXT CHECK (focus_keyword IS NULL OR char_length(focus_keyword) <= 80),
  meta_title       TEXT CHECK (meta_title IS NULL OR char_length(meta_title) <= 120),
  meta_description TEXT CHECK (meta_description IS NULL OR char_length(meta_description) <= 320),
  canonical_url    TEXT CHECK (canonical_url IS NULL OR canonical_url ~ '^https://'),
  og_image_url     TEXT CHECK (og_image_url IS NULL OR og_image_url ~ '^https://'),
  noindex          BOOLEAN NOT NULL DEFAULT false,
  -- derived / counters
  word_count       INTEGER NOT NULL DEFAULT 0,
  reading_minutes  INTEGER NOT NULL DEFAULT 1,
  view_count       BIGINT NOT NULL DEFAULT 0,
  search_vector    TSVECTOR,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blog_posts_published ON blog_posts (published_at DESC) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_blog_posts_category ON blog_posts (category_id);
CREATE INDEX IF NOT EXISTS idx_blog_posts_tags ON blog_posts USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_blog_posts_search ON blog_posts USING GIN (search_vector);

CREATE OR REPLACE FUNCTION blog_posts_before_write() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := NOW();
  IF NEW.status = 'published' AND NEW.published_at IS NULL THEN
    NEW.published_at := NOW();
  END IF;
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.excerpt, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(array_to_string(NEW.tags, ' '), '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.focus_keyword, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_blog_posts_before_write ON blog_posts;
CREATE TRIGGER trg_blog_posts_before_write
  BEFORE INSERT OR UPDATE ON blog_posts
  FOR EACH ROW EXECUTE FUNCTION blog_posts_before_write();

-- Daily view counts: the "Trending" ranking looks at the last N days.
CREATE TABLE IF NOT EXISTS blog_post_daily_views (
  post_id UUID NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
  day     DATE NOT NULL,
  views   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, day)
);

-- Starter categories (editable from the dashboard).
INSERT INTO blog_categories (name, slug, description, sort_order) VALUES
  ('Laundry Tips',  'laundry-tips',  'Everyday washing, drying and ironing know-how.', 1),
  ('Dry Cleaning',  'dry-cleaning',  'What to dry clean, what not to, and how it works.', 2),
  ('Fabric Care',   'fabric-care',   'Look after silk, wool, cotton, denim and more.', 3),
  ('Stain Removal', 'stain-removal', 'Get rid of tough stains the right way.', 4),
  ('LNDRY News',    'lndry-news',    'Product updates, new areas and partner stories.', 5)
ON CONFLICT (slug) DO NOTHING;
