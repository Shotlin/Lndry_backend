-- 155_price_list_catalogue.sql
--
-- Aligns the admin catalogue ("Categories & Subcategories" in the dashboard) with the printed LNDRY price
-- list: for each of the five live categories, the items (garment_types) are EXACTLY the flyer's items with
-- the flyer's prices (garment_types.cost_price is the dashboard's "Demo Price"). Anything else in those
-- categories is removed. Carpet and Curtain are billed per square foot (unit 'sqft').
--
--   Laundry Service            slug laundry-service
--   Men's Wear Dry Cleaning    slug mens-wear-dry-cleaning
--   Women's Wear Dry Cleaning  slug womens-wear-dry-cleaning
--   Household Dry Cleaning     slug household-dry-cleaning
--   Accessories Dry Cleaning   slug accessories-dry-cleaning
--
-- Categories themselves are never created, renamed, or deleted here (the admin manages those). A category
-- whose slug is not found is skipped. Items that cannot be deleted because something still references them
-- (e.g. a tagged garment unit) are deactivated instead. The seeded demo vendor's rates are re-synced to the
-- new prices so the customer app shows the flyer prices. Idempotent: re-running changes nothing.

DO $$
DECLARE
  cat RECORD;
  item RECORD;
  gid UUID;
  new_slug TEXT;
  catalogue JSONB := '{
    "laundry-service": [
      ["Wash & Fold", "kg", 80], ["Wash & Steam Iron", "kg", 120], ["Steam Iron", "piece", 16]
    ],
    "mens-wear-dry-cleaning": [
      ["Shirt / T-Shirt", "piece", 99], ["Trouser / Pant", "piece", 99], ["Jeans", "piece", 119],
      ["Kurta (Plain)", "piece", 129], ["Pyjama", "piece", 119], ["Blazer", "piece", 299], ["Coat", "piece", 369],
      ["Jacket (Short)", "piece", 299], ["Jacket (Long/Winter)", "piece", 449], ["Safari Suit", "piece", 300],
      ["Hoodie (Jacket Hood)", "piece", 299], ["Dhoti", "piece", 110], ["Sweater (Half)", "piece", 249],
      ["Sweater (Full)", "piece", 399], ["Cap", "piece", 130], ["Suit (2 Piece)", "piece", 599], ["Suit (3 Piece)", "piece", 749]
    ],
    "womens-wear-dry-cleaning": [
      ["Top (Plain)", "piece", 90], ["Blouse (Plain)", "piece", 90], ["Kurti", "piece", 129], ["Salwar (Plain)", "piece", 119],
      ["Petticoat", "piece", 80], ["Dupatta", "piece", 99], ["Saree (Plain)", "piece", 180], ["Silk Saree", "piece", 299],
      ["Designer Saree", "piece", 399], ["Lehenga (Plain)", "piece", 360], ["Gown", "piece", 399], ["Short Skirt", "piece", 120],
      ["Dress (Plain)", "piece", 249], ["Bridal Lehenga", "piece", 999]
    ],
    "household-dry-cleaning": [
      ["Bed Sheet (Single)", "piece", 165], ["Bed Sheet (Double)", "piece", 215], ["Pillow Covers", "piece", 75], ["Towel", "piece", 89],
      ["Blanket (Single)", "piece", 320], ["Blanket (Double)", "piece", 420], ["Quilt (Single)", "piece", 350], ["Quilt (Double)", "piece", 500],
      ["Carpet", "sqft", 40], ["Curtain", "sqft", 40]
    ],
    "accessories-dry-cleaning": [
      ["Sports Shoes", "piece", 329], ["Leather Shoes", "piece", 429], ["School Bag", "piece", 249], ["Office Bag", "piece", 399],
      ["Travel Bag", "piece", 499], ["Soft Toy (Small)", "piece", 150], ["Soft Toy (Large)", "piece", 250]
    ]
  }';
  slug_key TEXT;
  wanted TEXT[];
  entry JSONB;
BEGIN
  FOR slug_key IN SELECT jsonb_object_keys(catalogue) LOOP
    SELECT id, slug INTO cat FROM service_categories WHERE slug = slug_key LIMIT 1;
    IF cat.id IS NULL THEN
      RAISE NOTICE 'Category % not found - skipped', slug_key;
      CONTINUE;
    END IF;

    SELECT array_agg(e->>0) INTO wanted FROM jsonb_array_elements(catalogue -> slug_key) e;

    -- 1. remove every item in this category that is not on the price list
    FOR item IN SELECT id FROM garment_types WHERE category_id = cat.id AND NOT (name = ANY (wanted)) LOOP
      BEGIN
        DELETE FROM garment_types WHERE id = item.id;
      EXCEPTION WHEN foreign_key_violation THEN
        UPDATE garment_types SET is_active = false, updated_at = NOW() WHERE id = item.id;
      END;
    END LOOP;

    -- 2. create / update the price-list items
    FOR entry IN SELECT * FROM jsonb_array_elements(catalogue -> slug_key) LOOP
      SELECT id INTO gid FROM garment_types WHERE category_id = cat.id AND name = entry->>0 ORDER BY created_at LIMIT 1;
      IF gid IS NULL THEN
        new_slug := trim(both '-' from regexp_replace(lower(entry->>0), '[^a-z0-9]+', '-', 'g')) || '-' || cat.slug;
        INSERT INTO garment_types (name, slug, unit, cost_price, category_id, is_active)
        VALUES (entry->>0, new_slug, entry->>1, (entry->>2)::numeric, cat.id, true)
        ON CONFLICT (slug) DO NOTHING;
      ELSE
        UPDATE garment_types
           SET unit = entry->>1, cost_price = (entry->>2)::numeric, is_active = true, updated_at = NOW()
         WHERE id = gid
           AND (unit IS DISTINCT FROM entry->>1 OR cost_price IS DISTINCT FROM (entry->>2)::numeric OR is_active IS NOT TRUE);
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- Demo vendor (seed: "LNDRY Prime - Bengaluru Hub"): give it a rate for every price-list item at the list
-- price, so the customer app and POS demo show the flyer prices. Only touches that one seeded vendor.
DO $$
DECLARE
  demo_vendor UUID := '11111111-1111-4111-8111-111111111111';
  vs UUID;
  cat RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vendors WHERE id = demo_vendor) THEN
    RETURN;
  END IF;
  FOR cat IN
    SELECT id, name FROM service_categories
    WHERE slug IN ('laundry-service','mens-wear-dry-cleaning','womens-wear-dry-cleaning','household-dry-cleaning','accessories-dry-cleaning')
  LOOP
    SELECT id INTO vs FROM vendor_services WHERE vendor_id = demo_vendor AND category_id = cat.id LIMIT 1;
    IF vs IS NULL THEN
      INSERT INTO vendor_services (vendor_id, category_id, name, price, status)
      VALUES (demo_vendor, cat.id, cat.name, 100, 'PUBLISHED')
      ON CONFLICT (vendor_id, category_id) DO NOTHING
      RETURNING id INTO vs;
      IF vs IS NULL THEN
        SELECT id INTO vs FROM vendor_services WHERE vendor_id = demo_vendor AND category_id = cat.id LIMIT 1;
      END IF;
    END IF;
    IF vs IS NULL THEN CONTINUE; END IF;

    INSERT INTO vendor_service_rates (vendor_service_id, garment_type_id, rate_paise, is_active)
    SELECT vs, g.id, (g.cost_price * 100)::int, true
      FROM garment_types g
     WHERE g.category_id = cat.id AND g.is_active AND g.cost_price IS NOT NULL
    ON CONFLICT (vendor_service_id, garment_type_id)
      DO UPDATE SET rate_paise = EXCLUDED.rate_paise, is_active = true;
  END LOOP;
END $$;
