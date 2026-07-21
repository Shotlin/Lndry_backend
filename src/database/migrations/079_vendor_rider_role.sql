-- Vendors manage their own delivery riders (their own staff, not the
-- separate platform-wide gig-rider system in src/modules/delivery/).
-- Named VENDOR_RIDER (not RIDER) to avoid colliding with the unrelated
-- platform-wide `RIDER` value already on the users.role enum.
ALTER TABLE vendor_employees DROP CONSTRAINT IF EXISTS chk_vendor_employees_role;
ALTER TABLE vendor_employees ADD CONSTRAINT chk_vendor_employees_role
  CHECK (role IN ('VENDOR_OWNER', 'VENDOR_STAFF', 'VENDOR_RIDER'));
