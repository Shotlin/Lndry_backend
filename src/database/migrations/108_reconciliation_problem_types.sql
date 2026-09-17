-- Vendor "report a problem" system for order reconciliation (re-evaluation).
-- Two parts:
--   1. reconciliation_problem_types — an admin-managed, universal library of
--      selectable problem reasons (e.g. "Damaged Item", "Item Not Applicable
--      to This Service"), shown to every vendor. Purely descriptive/
--      evidentiary — it does NOT drive pricing on its own; the vendor still
--      makes the actual money change via the existing confirmed_quantity /
--      new_garment_type_id controls on the same reconcile request. This
--      table just lets that change carry a structured, admin-curated reason
--      instead of free text, for customer/admin transparency.
--   2. order_reconciliation_problems — one row per flagged line item on a
--      given reconciliation attempt, with 1-3 photos as evidence. A NULL
--      problem_type_id means the vendor picked "Other" and wrote their own
--      custom_message instead of using an admin-defined category.
CREATE TABLE IF NOT EXISTS reconciliation_problem_types (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label       VARCHAR(100) NOT NULL,
  description VARCHAR(255),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_reconciliation_problems (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_reconciliation_id   UUID NOT NULL REFERENCES order_reconciliations(id) ON DELETE CASCADE,
  order_line_id             UUID NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  problem_type_id           UUID REFERENCES reconciliation_problem_types(id),
  custom_message            VARCHAR(500),
  photo_urls                TEXT[] NOT NULL,
  created_by                UUID REFERENCES users(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_reconciliation_problem_photo_count
    CHECK (array_length(photo_urls, 1) BETWEEN 1 AND 3),
  -- "Other" (no admin-defined type) must always explain itself.
  CONSTRAINT chk_reconciliation_problem_reason
    CHECK (problem_type_id IS NOT NULL OR (custom_message IS NOT NULL AND length(trim(custom_message)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_order_reconciliation_problems_reconciliation
  ON order_reconciliation_problems(order_reconciliation_id);
CREATE INDEX IF NOT EXISTS idx_order_reconciliation_problems_line
  ON order_reconciliation_problems(order_line_id);

-- Starter categories matching the two cases the feature was requested for.
-- Admin adds/edits the rest from the dashboard — see
-- src/modules/admin/reconciliation-problem-types/.
INSERT INTO reconciliation_problem_types (label, description, sort_order)
VALUES
  ('Damaged Item', 'The garment was already torn, stained, or otherwise damaged before wash.', 1),
  ('Item Not Applicable to This Service', 'This garment does not belong under the service the customer selected (e.g. a T-shirt inside a bulk kg wash) and was moved to its correct service.', 2);
