-- Migration 075: seeds the remaining 4 categories from the vendor's printed
-- rate card (Men's/Women's/Household/Accessories Dry Cleaning), all
-- piece-based, alongside the kg-based "Laundry Services" category from
-- migration 074. Idempotent via slug guards; does not touch any existing
-- category or garment_type row (legacy or otherwise).

-- ── Men's Wear Dry Cleaning ──────────────────────────────────────────────
INSERT INTO service_categories (name, slug, description, sort_order, is_active)
SELECT 'Men''s Wear Dry Cleaning', 'mens-wear-dry-cleaning', 'Shirts, suits and everyday menswear dry cleaning', 1, true
WHERE NOT EXISTS (SELECT 1 FROM service_categories WHERE slug = 'mens-wear-dry-cleaning');

INSERT INTO garment_types (name, slug, unit, cost_price, category_id, is_active)
SELECT v.name, v.slug, 'piece', v.price, sc.id, true
FROM service_categories sc
CROSS JOIN (VALUES
  ('Shirt', 'shirt-mens-wear-dry-cleaning', 90.00),
  ('T-Shirt', 't-shirt-mens-wear-dry-cleaning', 90.00),
  ('Pant', 'pant-mens-wear-dry-cleaning', 100.00),
  ('Coat', 'coat-mens-wear-dry-cleaning', 300.00),
  ('Jacket (Half)', 'jacket-half-mens-wear-dry-cleaning', 250.00),
  ('Jacket (Full)', 'jacket-full-mens-wear-dry-cleaning', 400.00),
  ('Hoodie (Jacket Hood)', 'hoodie-mens-wear-dry-cleaning', 300.00),
  ('Pyjama', 'pyjama-mens-wear-dry-cleaning', 110.00),
  ('Dhoti', 'dhoti-mens-wear-dry-cleaning', 110.00),
  ('Kurta (Plain)', 'kurta-plain-mens-wear-dry-cleaning', 110.00),
  ('Sweater (Half)', 'sweater-half-mens-wear-dry-cleaning', 264.00),
  ('Sweater (Full)', 'sweater-full-mens-wear-dry-cleaning', 400.00),
  ('Safari Suit', 'safari-suit-mens-wear-dry-cleaning', 300.00),
  ('Cap', 'cap-mens-wear-dry-cleaning', 130.00)
) AS v(name, slug, price)
WHERE sc.slug = 'mens-wear-dry-cleaning'
  AND NOT EXISTS (SELECT 1 FROM garment_types WHERE slug = v.slug);

-- ── Women's Wear Dry Cleaning ────────────────────────────────────────────
INSERT INTO service_categories (name, slug, description, sort_order, is_active)
SELECT 'Women''s Wear Dry Cleaning', 'womens-wear-dry-cleaning', 'Sarees, dresses and everyday womenswear dry cleaning', 2, true
WHERE NOT EXISTS (SELECT 1 FROM service_categories WHERE slug = 'womens-wear-dry-cleaning');

INSERT INTO garment_types (name, slug, unit, cost_price, category_id, is_active)
SELECT v.name, v.slug, 'piece', v.price, sc.id, true
FROM service_categories sc
CROSS JOIN (VALUES
  ('Petticoat', 'petticoat-womens-wear-dry-cleaning', 80.00),
  ('Kurta', 'kurta-womens-wear-dry-cleaning', 110.00),
  ('Short Skirt', 'short-skirt-womens-wear-dry-cleaning', 120.00),
  ('Salwar (Plain)', 'salwar-plain-womens-wear-dry-cleaning', 110.00),
  ('Dress (Plain)', 'dress-plain-womens-wear-dry-cleaning', 200.00),
  ('Saree (Plain)', 'saree-plain-womens-wear-dry-cleaning', 180.00),
  ('Lehenga (Plain)', 'lehenga-plain-womens-wear-dry-cleaning', 360.00),
  ('Blouse (Plain)', 'blouse-plain-womens-wear-dry-cleaning', 70.00),
  ('Top (Plain)', 'top-plain-womens-wear-dry-cleaning', 100.00),
  ('Silk Saree / Designer Saree', 'silk-designer-saree-womens-wear-dry-cleaning', 250.00)
) AS v(name, slug, price)
WHERE sc.slug = 'womens-wear-dry-cleaning'
  AND NOT EXISTS (SELECT 1 FROM garment_types WHERE slug = v.slug);

-- ── Household Dry Cleaning ───────────────────────────────────────────────
INSERT INTO service_categories (name, slug, description, sort_order, is_active)
SELECT 'Household Dry Cleaning', 'household-dry-cleaning', 'Bedsheets, blankets, quilts and other home textiles', 3, true
WHERE NOT EXISTS (SELECT 1 FROM service_categories WHERE slug = 'household-dry-cleaning');

INSERT INTO garment_types (name, slug, unit, cost_price, category_id, is_active)
SELECT v.name, v.slug, 'piece', v.price, sc.id, true
FROM service_categories sc
CROSS JOIN (VALUES
  ('Carpet / Curtain', 'carpet-curtain-household-dry-cleaning', 50.00),
  ('Bedsheet (Single)', 'bedsheet-single-household-dry-cleaning', 180.00),
  ('Bedsheet (Double)', 'bedsheet-double-household-dry-cleaning', 240.00),
  ('Pillow Covers', 'pillow-covers-household-dry-cleaning', 75.00),
  ('Blanket (Single)', 'blanket-single-household-dry-cleaning', 300.00),
  ('Blanket (Double)', 'blanket-double-household-dry-cleaning', 450.00),
  ('Quilt (Single)', 'quilt-single-household-dry-cleaning', 350.00),
  ('Quilt (Double)', 'quilt-double-household-dry-cleaning', 500.00),
  ('Hand Towel', 'hand-towel-household-dry-cleaning', 75.00)
) AS v(name, slug, price)
WHERE sc.slug = 'household-dry-cleaning'
  AND NOT EXISTS (SELECT 1 FROM garment_types WHERE slug = v.slug);

-- ── Accessories Dry Cleaning ─────────────────────────────────────────────
INSERT INTO service_categories (name, slug, description, sort_order, is_active)
SELECT 'Accessories Dry Cleaning', 'accessories-dry-cleaning', 'Shoes, bags, toys and other accessories dry cleaning', 4, true
WHERE NOT EXISTS (SELECT 1 FROM service_categories WHERE slug = 'accessories-dry-cleaning');

INSERT INTO garment_types (name, slug, unit, cost_price, category_id, is_active)
SELECT v.name, v.slug, 'piece', v.price, sc.id, true
FROM service_categories sc
CROSS JOIN (VALUES
  ('Sports Shoes', 'sports-shoes-accessories-dry-cleaning', 250.00),
  ('Leather Shoes', 'leather-shoes-accessories-dry-cleaning', 300.00),
  ('Soft Toy (Base)', 'soft-toy-base-accessories-dry-cleaning', 150.00),
  ('Soft Toy (Small)', 'soft-toy-small-accessories-dry-cleaning', 200.00),
  ('Suitcase (Base)', 'suitcase-base-accessories-dry-cleaning', 275.00),
  ('Suitcase (Small)', 'suitcase-small-accessories-dry-cleaning', 375.00)
) AS v(name, slug, price)
WHERE sc.slug = 'accessories-dry-cleaning'
  AND NOT EXISTS (SELECT 1 FROM garment_types WHERE slug = v.slug);
