-- Migration 082: add order statuses for the vendor-recalculation customer
-- approval gate. RECONCILIATION_PENDING sits between RECEIVED_AT_VENDOR and
-- PROCESSING — the vendor has submitted a corrected weight/count with photo
-- evidence and the customer must accept or reject before washing starts.
-- RECONCILIATION_DISPUTED is the reject outcome, resolved by a support call
-- (not another automated flow) followed by either a vendor resubmission or
-- an admin cancellation.

DO $$
BEGIN
  ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'RECONCILIATION_PENDING';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$
BEGIN
  ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'RECONCILIATION_DISPUTED';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
