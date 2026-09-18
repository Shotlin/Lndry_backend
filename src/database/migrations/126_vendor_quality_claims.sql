-- 126_vendor_quality_claims.sql
--
-- Quality-exception workflow on a specific garment, ported from
-- epic-laundry-desktop's quality.ts. Resolving a claim with a Rewash/
-- Damaged/Missing decision drives the garment's own state machine (reuses
-- vendor-garment-units' scan logic, exactly like epic's resolveQualityClaim
-- calls its own scanLaundryGarment) and issues a customer-facing
-- "correction" record — a plain-language notice of what happened and what
-- was decided, same as epic's issueCustomerCorrection.
--
-- Distinct from the existing order_reconciliation_problems (migration 108,
-- the Reconciliation Problem Reporting feature) — that's evidence attached
-- at the vendor's initial re-evaluation of a received order (before any
-- garment unit exists); this is a claim raised mid-processing against a
-- specific already-tagged physical garment, with a full lifecycle and a
-- customer-facing outcome. Different moment, different granularity.

CREATE TABLE IF NOT EXISTS vendor_quality_claims (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id        UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  garment_unit_id  UUID NOT NULL REFERENCES vendor_garment_units(id) ON DELETE CASCADE,
  order_id         UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  category         VARCHAR(10) NOT NULL CHECK (category IN ('STAIN', 'DAMAGE', 'MISSING', 'REWASH', 'OTHER')),
  severity         VARCHAR(10) NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  status           VARCHAR(15) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED')),
  description      VARCHAR(1000) NOT NULL,
  opened_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_by        UUID NOT NULL REFERENCES users(id),
  decision         VARCHAR(10) CHECK (decision IN ('REWASH', 'DAMAGED', 'MISSING', 'RELEASE', 'REJECT')),
  resolution_note  VARCHAR(1000),
  resolved_at      TIMESTAMPTZ,
  resolved_by      UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one open (OPEN/UNDER_REVIEW) claim per garment at a time, mirrors epic's guard.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_quality_claims_open_unit
  ON vendor_quality_claims (garment_unit_id) WHERE status IN ('OPEN', 'UNDER_REVIEW');
CREATE INDEX IF NOT EXISTS idx_vendor_quality_claims_vendor ON vendor_quality_claims(vendor_id, status);

CREATE TABLE IF NOT EXISTS vendor_customer_corrections (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  claim_id         UUID NOT NULL REFERENCES vendor_quality_claims(id) ON DELETE CASCADE,
  customer_user_id UUID NOT NULL REFERENCES users(id),
  order_id         UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  garment_unit_id  UUID NOT NULL REFERENCES vendor_garment_units(id) ON DELETE CASCADE,
  decision         VARCHAR(10) NOT NULL,
  summary          VARCHAR(500) NOT NULL,
  customer_message VARCHAR(1600) NOT NULL,
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  issued_by        UUID NOT NULL REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_customer_corrections_claim ON vendor_customer_corrections(claim_id);
CREATE INDEX IF NOT EXISTS idx_vendor_customer_corrections_order ON vendor_customer_corrections(order_id);
