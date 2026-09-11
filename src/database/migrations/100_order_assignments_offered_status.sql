-- 100_order_assignments_offered_status.sql
--
-- Phase 2 of the rider-assignment initiative (see CLAUDE.md "Rider
-- Assignment: Broadcast + Timeout Reassignment System"). Adds an explicit
-- pre-acceptance state distinct from 'ASSIGNED' (which today means
-- "confirmed, shows in the rider's job list and counts toward their
-- active-job workload"). An OFFERED row is NOT yet confirmed — the rider
-- must call the new accept endpoint (an atomic
-- UPDATE ... WHERE status = 'OFFERED') to flip it to ASSIGNED, or decline
-- it (flips to the already-existing 'CANCELLED' value) to free it up.
--
-- Purely additive to the existing CHECK constraint — named
-- delivery_assignments_status_check from before this table was renamed
-- order_assignments (see the self-rename-bug history in this same
-- migrations folder). 'ACCEPTED' already sits in that same constraint,
-- unused by any current LNDRY code (a leftover from the shared scaffold);
-- this migration doesn't touch it, just adds 'OFFERED' alongside it.
--
-- Zero behavior change on its own: nothing writes 'OFFERED' yet except
-- the new VendorOrdersService#offerToEmployee (an explicit alternative a
-- vendor can choose instead of Phase 1's direct assignSpecificEmployee) —
-- the existing auto-assign/backfill/reassign paths are untouched and
-- keep writing 'ASSIGNED' directly, so no order already in flight is
-- affected.

ALTER TABLE order_assignments DROP CONSTRAINT IF EXISTS delivery_assignments_status_check;
ALTER TABLE order_assignments ADD CONSTRAINT delivery_assignments_status_check
  CHECK (status IN ('OFFERED', 'ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'));
