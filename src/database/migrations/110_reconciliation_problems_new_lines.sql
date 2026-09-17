-- A reported re-evaluation problem originally required a real, already-
-- existing order_lines.id — but a line the vendor is adding mid-
-- reconciliation (via new_lines[] on the reconcile request, e.g. moving a
-- T-shirt out of a bulk kg wash into its own per-piece service) doesn't
-- have a real id yet: it's only INSERTed into order_lines once the
-- customer accepts (see applyRecalculatedTotals in order-recalculation.js).
-- Loosen order_line_id to nullable and add new_line_index — the 0-based
-- position of the entry within that same reconcile request's new_lines[]
-- array — as the alternative reference. Exactly one of the two must be set.
ALTER TABLE order_reconciliation_problems
  ALTER COLUMN order_line_id DROP NOT NULL,
  ADD COLUMN new_line_index INTEGER;

ALTER TABLE order_reconciliation_problems
  ADD CONSTRAINT chk_reconciliation_problem_line_ref
    CHECK ((order_line_id IS NOT NULL) <> (new_line_index IS NOT NULL));
