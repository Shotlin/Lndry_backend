-- Migration 074: seeds the "Laundry Services" category with its 2 starter
-- subcategories (Wash & Fold, Wash & Steam Iron), both kg-based, as the
-- concrete example admin gets on top of the existing 8 legacy categories.
-- Idempotent via slug guards; does not touch any existing category or
-- garment_type row.

INSERT INTO service_categories (name, slug, description, sort_order, is_active)
SELECT 'Laundry Services', 'laundry-services', 'Everyday wash, fold and iron laundry billed by weight', 0, true
WHERE NOT EXISTS (SELECT 1 FROM service_categories WHERE slug = 'laundry-services');

INSERT INTO garment_types (name, slug, unit, cost_price, category_id, is_active)
SELECT 'Wash & Fold', 'wash-fold-laundry-services', 'kg', 80.00, sc.id, true
FROM service_categories sc
WHERE sc.slug = 'laundry-services'
  AND NOT EXISTS (SELECT 1 FROM garment_types WHERE slug = 'wash-fold-laundry-services');

INSERT INTO garment_types (name, slug, unit, cost_price, category_id, is_active)
SELECT 'Wash & Steam Iron', 'wash-steam-iron-laundry-services', 'kg', 120.00, sc.id, true
FROM service_categories sc
WHERE sc.slug = 'laundry-services'
  AND NOT EXISTS (SELECT 1 FROM garment_types WHERE slug = 'wash-steam-iron-laundry-services');
