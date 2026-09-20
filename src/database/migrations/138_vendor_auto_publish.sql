-- 138_vendor_auto_publish.sql
-- Customer discovery only lists vendors with marketplace_published = true, and
-- the only thing that ever set it was the vendor pressing "Publish to
-- marketplace" in the Partner app. A vendor that had been approved and was
-- fully set up (services, rates, pickup slots, location) therefore stayed
-- invisible to customers until they found that button.
--
-- Vendors are now published automatically the first time they are service-ready
-- (see src/modules/vendors/vendor-publishing.js). This column records that it
-- has happened once, so an admin who later UNpublishes a vendor on purpose is
-- never overruled by the automatic step.

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS marketplace_auto_published_at TIMESTAMPTZ;

-- Vendors that are already published have had their one automatic chance.
UPDATE vendors
   SET marketplace_auto_published_at = COALESCE(marketplace_auto_published_at, NOW())
 WHERE marketplace_published = true;
