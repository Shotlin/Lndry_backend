-- Optional Google Business Profile connection per vendor — an external
-- trust signal shown alongside (never instead of) the existing LNDRY
-- reviews system. Every column is nullable: no link configured is the
-- default and normal state for every existing vendor.
--
-- Deliberately NOT an automated Google Places/Maps API lookup: the admin
-- (or vendor) pastes the public Google Maps/Business link AND types in the
-- current rating/review count they see on their own Google listing. There
-- is no server-side scraping or resolution step — this is admin-maintained
-- data, refreshed whenever they choose to update it.
--   google_business_url   — the pasted Google Maps/Business link, used
--                            as-is for "View on Google".
--   google_rating         — admin-entered (e.g. 4.7).
--   google_review_count   — admin-entered total review count.
--   google_business_name  — optional display name (falls back to the
--                            vendor's own LNDRY name in the app if blank).
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS google_business_url TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS google_rating NUMERIC(2,1);
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS google_review_count INTEGER;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS google_business_name TEXT;
