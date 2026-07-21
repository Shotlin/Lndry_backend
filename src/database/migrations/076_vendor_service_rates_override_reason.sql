-- Migration 076: adds an admin-supplied reason for price recalculations.
-- When admin overrides a vendor's own subcategory price ("recalculate"),
-- they can attach a short note explaining why — shown back to the vendor
-- alongside the subcategory it applies to, and pushed as a notification.
-- No existing dormant column on vendor_service_rates fits this (unlike
-- vendor_services.rejection_reason, which is already committed to reject
-- semantics), so this is a genuine new nullable column.

ALTER TABLE vendor_service_rates
  ADD COLUMN IF NOT EXISTS override_reason TEXT,
  ADD COLUMN IF NOT EXISTS override_at TIMESTAMPTZ;
