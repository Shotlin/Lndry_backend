-- The admin review API and service have supported SUSPENDED since the
-- vendor-application workflow was introduced, but migration 062 omitted it
-- from the application-state constraint. Keep the persisted state machine in
-- lockstep with the existing, ADMIN-only review contract. This changes only
-- future/current application validation; no historical row is rewritten.
ALTER TABLE vendor_applications
  DROP CONSTRAINT IF EXISTS chk_vendor_applications_status;

ALTER TABLE vendor_applications
  ADD CONSTRAINT chk_vendor_applications_status
  CHECK (status IN (
    'DRAFT',
    'WAITING_FOR_APPROVAL',
    'CORRECTION_REQUIRED',
    'APPROVED',
    'REJECTED',
    'SUSPENDED'
  ));
