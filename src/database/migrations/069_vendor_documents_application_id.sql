-- Migration 069: Fix vendor_documents / vendor_applications mismatch
--
-- vendors.repository.js (addApplicationDocument / getApplicationDocuments)
-- and vendors.service.js's approval flow have always referenced a
-- `vendor_documents.vendor_application_id` column that migration 057 never
-- created (it only added `vendor_id UUID NOT NULL REFERENCES vendors(id)`).
-- The result: uploading a KYC document during the application phase, an
-- admin viewing a pending application's documents, and approving *any*
-- application (the approval transaction unconditionally tries to migrate
-- application-phase documents onto the new vendor row) all fail with
-- "column vendor_application_id does not exist".
--
-- Fix: let a vendor_documents row belong to either a vendor_application
-- (pre-approval) or a vendor (post-approval), never both — vendor_id
-- becomes nullable, vendor_application_id is added, and a CHECK constraint
-- enforces exactly one is set. The approval-time migration UPDATE
-- (vendors.service.js) already assumes this shape; it just needed the
-- column to exist.

ALTER TABLE vendor_documents ALTER COLUMN vendor_id DROP NOT NULL;

ALTER TABLE vendor_documents
  ADD COLUMN IF NOT EXISTS vendor_application_id UUID REFERENCES vendor_applications(id) ON DELETE CASCADE;

ALTER TABLE vendor_documents
  DROP CONSTRAINT IF EXISTS chk_vendor_documents_owner;

ALTER TABLE vendor_documents
  ADD CONSTRAINT chk_vendor_documents_owner CHECK (
    (vendor_id IS NOT NULL AND vendor_application_id IS NULL) OR
    (vendor_id IS NULL AND vendor_application_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_vendor_documents_application_id
  ON vendor_documents(vendor_application_id) WHERE vendor_application_id IS NOT NULL;
