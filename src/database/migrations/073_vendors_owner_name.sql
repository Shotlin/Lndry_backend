-- Migration 073: the `vendors` table (the live, post-approval entity) never
-- got an `owner_name` column even though `vendor_applications` did (migration
-- 071) — so once an application was approved, admin lost the ability to see
-- or edit the owner's name at all. Add it here so post-approval edits have
-- somewhere to write it.

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS owner_name VARCHAR(150);
