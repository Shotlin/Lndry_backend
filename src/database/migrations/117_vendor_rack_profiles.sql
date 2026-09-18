-- 117_vendor_rack_profiles.sql
--
-- Storage rack/bin profiles for a vendor's shop floor, ported from
-- epic-laundry-desktop's rack.ts#createRackProfile/updateRackProfile.
-- Profile CRUD (name/code/capacity) has no dependency on anything else and
-- ships now; live occupancy (which rack has which garment on it right now)
-- is deferred — it depends on the per-garment-unit scan/state-machine
-- tracking that doesn't exist in Lndry_backend yet (a later, larger phase).

CREATE TABLE IF NOT EXISTS vendor_rack_profiles (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id   UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  name        VARCHAR(120) NOT NULL,
  code        VARCHAR(40),
  capacity    INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 100000),
  active      BOOLEAN NOT NULL DEFAULT true,
  notes       VARCHAR(500),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_rack_profiles_name
  ON vendor_rack_profiles (vendor_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_rack_profiles_code
  ON vendor_rack_profiles (vendor_id, upper(code)) WHERE code IS NOT NULL AND code <> '';
