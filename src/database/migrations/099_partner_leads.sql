-- Canonical staging area for signed partner enquiries received from the
-- marketing website. A partner lead is intentionally NOT a vendor, user, or
-- vendor application: verified identity, required KYC documents and explicit
-- consented onboarding remain mandatory before the existing vendor workflow.

CREATE TABLE IF NOT EXISTS partner_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source = 'website-partners'),
  external_lead_id UUID NOT NULL,
  full_name TEXT NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 100),
  business_name TEXT NOT NULL CHECK (char_length(business_name) BETWEEN 2 AND 140),
  email TEXT NOT NULL CHECK (char_length(email) BETWEEN 5 AND 254),
  phone TEXT NOT NULL CHECK (phone ~ '^[+][1-9][0-9]{7,14}$'),
  city TEXT NOT NULL CHECK (char_length(city) BETWEEN 2 AND 80),
  address TEXT,
  service_area TEXT NOT NULL CHECK (char_length(service_area) BETWEEN 2 AND 180),
  services JSONB NOT NULL,
  business_type TEXT NOT NULL CHECK (char_length(business_type) BETWEEN 2 AND 80),
  years_in_business TEXT NOT NULL CHECK (char_length(years_in_business) BETWEEN 2 AND 40),
  estimated_monthly_orders TEXT NOT NULL CHECK (char_length(estimated_monthly_orders) BETWEEN 2 AND 60),
  pickup_delivery TEXT,
  daily_capacity TEXT,
  message TEXT,
  privacy_consent BOOLEAN NOT NULL CHECK (privacy_consent = true),
  source_submitted_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_count INTEGER NOT NULL DEFAULT 1 CHECK (received_count >= 1),
  state TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (state IN ('RECEIVED', 'CLAIMED', 'ARCHIVED')),
  claimed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ,
  onboarding_application_id UUID REFERENCES vendor_applications(id) ON DELETE SET NULL,
  CONSTRAINT partner_leads_source_external_unique UNIQUE (source, external_lead_id)
);

CREATE INDEX IF NOT EXISTS partner_leads_state_received_idx
  ON partner_leads (state, received_at DESC);
