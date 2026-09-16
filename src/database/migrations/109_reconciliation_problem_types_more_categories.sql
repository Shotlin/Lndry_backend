-- Four more universal reconciliation problem-report categories, requested
-- by the user directly (not derivable from code) to round out the two
-- seeded in 108_reconciliation_problem_types.sql. Admin can still
-- add/edit/deactivate further ones from the dashboard at any time — this
-- is just more starter data via the same versioned-migration mechanism the
-- first two categories used, not a one-off.
INSERT INTO reconciliation_problem_types (label, description, sort_order)
VALUES
  ('Missing Item', 'One or more items the customer listed were not found in the bag received.', 3),
  ('Stain Not Fully Removable', 'The item was washed but a stain could not be completely removed.', 4),
  ('Extra / Unlisted Item Found', 'An item was found in the bag that was not part of the customer''s original order.', 5),
  ('Wrong Item / Mismatch', 'The item does not match what the customer described (e.g. wrong size, fabric, or type).', 6);
