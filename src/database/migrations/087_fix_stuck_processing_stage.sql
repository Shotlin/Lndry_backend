-- Data repair: acceptReconciliation used to move orders.status to PROCESSING
-- without also advancing orders.processing_stage, leaving it stuck at the
-- stale 'Received' value from when the order first arrived at the vendor.
-- That combination is invalid for updateProcessingStage's WASHING/DRYING/
-- IRONING/PACKED sub-sequence, so "Mark Packed & Ready" failed with
-- "Cannot go from RECEIVED to PACKED". orders.service.js now sets
-- processing_stage = 'Washing' when accepting a reconciliation; this is a
-- one-time repair for orders already stuck in the bad state.
UPDATE orders
SET processing_stage = 'Washing'
WHERE status = 'PROCESSING' AND processing_stage = 'Received';
