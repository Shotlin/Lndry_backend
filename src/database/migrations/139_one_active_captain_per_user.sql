-- 139_one_active_captain_per_user.sql
-- A captain (VENDOR_RIDER) belongs to exactly ONE vendor at a time. Nothing in
-- the database enforced that: the same mobile number could be added as a
-- captain by a second vendor, leaving the person with two active roster
-- records. Login then found several vendors, answered "select a shop" — which
-- the Partner app cannot do — and the app ended on "Unauthorized — invalid or
-- expired token".
--
-- 1) Repair: if any user already has more than one ACTIVE captain record, keep
--    the earliest (the vendor they were first registered with) and remove the
--    later ones, so the index below can be created.
-- 2) Enforce: at most one active captain record per user, whatever the app or
--    API does. "Active" = is_active AND not soft-deleted, the same meaning the
--    login lookup uses, so a removed or switched-off captain is free to be
--    added by another vendor.

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at ASC, id ASC) AS rn
    FROM vendor_employees
   WHERE role = 'VENDOR_RIDER' AND is_active = true AND deleted_at IS NULL
)
UPDATE vendor_employees ve
   SET is_active = false, deleted_at = NOW(), updated_at = NOW()
  FROM ranked
 WHERE ve.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_employees_one_active_captain
  ON vendor_employees (user_id)
  WHERE role = 'VENDOR_RIDER' AND is_active = true AND deleted_at IS NULL;
