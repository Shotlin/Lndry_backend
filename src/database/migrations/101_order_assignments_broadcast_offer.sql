-- 101_order_assignments_broadcast_offer.sql
--
-- Phase 3 of the rider-assignment initiative (see CLAUDE.md). Distinguishes
-- a broadcast offer (open to any of the vendor's active riders — first to
-- accept wins) from a targeted offer (Phase 2's offerToEmployee — meant
-- for one specific person, who alone can accept or decline it).
--
-- Why this is needed: order_assignments has exactly one row per
-- (order_id, assignment_type) — there's no candidate-pool table. A
-- broadcast still only ever creates ONE row (employee_id/rider_id hold a
-- placeholder — whoever was least busy at broadcast time — purely to
-- satisfy the NOT NULL rider_id column), but the accept endpoint's claim
-- query must let ANY active rider at that vendor win it, not just the
-- placeholder. is_broadcast_offer is what tells the accept/decline/list
-- queries which rule applies to a given OFFERED row.

ALTER TABLE order_assignments ADD COLUMN IF NOT EXISTS is_broadcast_offer BOOLEAN NOT NULL DEFAULT false;
