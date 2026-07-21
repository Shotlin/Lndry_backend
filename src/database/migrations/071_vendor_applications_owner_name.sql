-- Migration 071: vendor_applications had no column to store the owner's personal
-- name (only `name`, the business name, and `owner_id`, a FK to users). The admin
-- dashboard's application review screen displays an "Owner" field that always
-- read blank because nothing populated it. Add the column and let the onboarding
-- wizard's Owner & Bank Details step collect it.

ALTER TABLE vendor_applications ADD COLUMN IF NOT EXISTS owner_name VARCHAR(150);
