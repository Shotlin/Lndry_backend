-- 119_vendor_report_saved_views.sql
--
-- Saved report-filter presets, ported from epic-laundry-desktop's
-- report-views.ts. report_kind is a free-text label rather than a fixed
-- enum (unlike epic's own closed list of its 15 report kinds) — LNDRY's own
-- vendor-facing report surfaces (shop-reports, vendor-analytics) aren't a
-- single catalogue module here, so this table just tags whichever screen
-- saved it; the frontend is the source of truth for valid kinds.

CREATE TABLE IF NOT EXISTS vendor_report_saved_views (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id    UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  owner_id     UUID NOT NULL REFERENCES users(id),
  view_name    VARCHAR(120) NOT NULL,
  report_kind  VARCHAR(60) NOT NULL,
  from_date    DATE,
  to_date      DATE,
  search       VARCHAR(120),
  shared       BOOLEAN NOT NULL DEFAULT false,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_report_saved_views_owner
  ON vendor_report_saved_views (owner_id, report_kind, lower(view_name))
  WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_vendor_report_saved_views_vendor
  ON vendor_report_saved_views(vendor_id, report_kind);
