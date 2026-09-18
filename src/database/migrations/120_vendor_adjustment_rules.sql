-- 120_vendor_adjustment_rules.sql
--
-- Named, vendor-defined charge/discount line items for counter sales,
-- ported from epic-laundry-desktop's domain.ts#saveAdjustmentRule
-- (saveLaundryChargeRule/saveLaundryDiscountRule — one shared function
-- behind two names, both writing "Flat" or "Percentage" rules distinguished
-- only by which entity they're stored under). One table here instead of two,
-- with `kind` doing that same job — same data, same behavior, less
-- duplicated schema/module code.
--
-- Distinct from `coupons`/`first-time-offers`/`cart-milestones`: those are
-- customer-facing, platform-admin-managed promotions. This is the vendor's
-- own configurable line items for a counter sale (e.g. a standing "Express
-- Service" surcharge or a standing "Senior Citizen" discount) — applied at
-- counter-sale booking time, which is a later phase (Tier 3).
--
-- Amount is split into flat_amount_paise / percentage_bps (basis points,
-- 0-10000 = 0-100.00%) rather than one ambiguous numeric column, so Postgres
-- enforces which one is actually meaningful for a given rule's type.

CREATE TABLE IF NOT EXISTS vendor_adjustment_rules (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id           UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  kind                VARCHAR(10) NOT NULL CHECK (kind IN ('CHARGE', 'DISCOUNT')),
  name                VARCHAR(160) NOT NULL,
  type                VARCHAR(10) NOT NULL CHECK (type IN ('FLAT', 'PERCENTAGE')),
  flat_amount_paise   INTEGER CHECK (flat_amount_paise >= 0),
  percentage_bps      INTEGER CHECK (percentage_bps BETWEEN 0 AND 10000),
  description         VARCHAR(500),
  active              BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_vendor_adjustment_rules_amount CHECK (
    (type = 'FLAT' AND flat_amount_paise IS NOT NULL AND percentage_bps IS NULL) OR
    (type = 'PERCENTAGE' AND percentage_bps IS NOT NULL AND flat_amount_paise IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_adjustment_rules_name
  ON vendor_adjustment_rules (vendor_id, kind, lower(name));
CREATE INDEX IF NOT EXISTS idx_vendor_adjustment_rules_vendor
  ON vendor_adjustment_rules(vendor_id, kind) WHERE active = true;
