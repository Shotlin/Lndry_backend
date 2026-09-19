-- 136_staff_permissions_backfill.sql
--
-- Vendor-app permissions are now ENFORCED per route (middlewares/
-- vendor-permission.js). Until now a staff member's permission list was
-- stored but never checked on the vendor-app modules, so every existing staff
-- member effectively had full access. This adds the newly introduced
-- permission strings to existing staff whose current permissions already imply
-- them, so nobody silently loses access they were using the moment this
-- ships. Narrowly scoped staff stay narrow; the owner can tighten anyone from
-- the Permissions screen afterwards.
--
--   shop_orders.update_status  ->  + shop_orders.accept_reject, shop_orders.reevaluate
--   vendor_services.update     ->  + vendor_slots.(view|manage), vendor_inventory.(view|manage)
--   vendor_services.view       ->  + vendor_slots.view, vendor_inventory.view
--
-- Captains (VENDOR_RIDER) and owners are untouched. Idempotent.

UPDATE vendor_employees ve
   SET permissions = (
         SELECT COALESCE(jsonb_agg(DISTINCT p ORDER BY p), '[]'::jsonb)
           FROM (
                 SELECT jsonb_array_elements_text(ve.permissions) AS p
                 UNION
                 SELECT unnest(ARRAY['shop_orders.accept_reject', 'shop_orders.reevaluate'])
                  WHERE ve.permissions ? 'shop_orders.update_status'
                 UNION
                 SELECT unnest(ARRAY['vendor_slots.view', 'vendor_slots.manage', 'vendor_inventory.view', 'vendor_inventory.manage'])
                  WHERE ve.permissions ? 'vendor_services.update'
                 UNION
                 SELECT unnest(ARRAY['vendor_slots.view', 'vendor_inventory.view'])
                  WHERE ve.permissions ? 'vendor_services.view'
               ) t
       ),
       updated_at = NOW()
 WHERE ve.role = 'VENDOR_STAFF'
   AND ve.deleted_at IS NULL
   AND jsonb_typeof(ve.permissions) = 'array'
   AND (
        ve.permissions ? 'shop_orders.update_status'
     OR ve.permissions ? 'vendor_services.update'
     OR ve.permissions ? 'vendor_services.view'
   );
