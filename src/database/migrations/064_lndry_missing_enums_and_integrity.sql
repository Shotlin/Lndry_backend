-- Migration 064: LNDRY Phase 1 — missing enum values, OTP hardening, and integrity check
-- Adds enum values that the state machine requires but were not yet in the DB enum,
-- hardens OTP tables for single-use + purpose enforcement, and verifies all required
-- tables exist at the end.

-- ─── 1. ADD MISSING order_status ENUM VALUES ──────────────────────────────────
-- These statuses are used by the state machine but were not explicitly added
-- in migrations 057/058. ADD VALUE IF NOT EXISTS is safe for re-runs.

DO $$
BEGIN
  ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'PACKED';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'OUT_FOR_DELIVERY';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'DELIVERED';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'REFUNDED';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'CANCELLED';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'PROCESSING';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ─── 2. HARDEN otp_challenges TABLE ──────────────────────────────────────────
-- Add purpose and used_at columns for single-use + purpose-bound enforcement.

ALTER TABLE otp_challenges ADD COLUMN IF NOT EXISTS purpose VARCHAR(50) DEFAULT 'LOGIN';
ALTER TABLE otp_challenges ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;

-- ─── 3. HARDEN order_otps TABLE ──────────────────────────────────────────────
-- Add used_at column (alias for consumed_at for API consistency).
-- consumed_at already exists from migration 062; add used_at as a synonym.

ALTER TABLE order_otps ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;

-- Sync consumed_at → used_at for existing records
UPDATE order_otps SET used_at = consumed_at WHERE used_at IS NULL AND consumed_at IS NOT NULL;

-- ─── 4. ADD CANONICAL ROLES to user_role enum and update chk_users_platform_role ───

DO $$
BEGIN
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'RIDER';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'SUPER_ADMIN';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'FINANCE_ADMIN';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'VENDOR_APPLICANT';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_platform_role;
ALTER TABLE users ADD CONSTRAINT chk_users_platform_role
  CHECK (platform_role IS NULL OR platform_role IN ('SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN'));

-- ─── 5. POST-MIGRATION INTEGRITY CHECK ──────────────────────────────────────
-- Asserts that ALL required LNDRY Phase 1 tables exist. If any table is missing,
-- the migration fails with a descriptive error, preventing silent schema drift.

DO $$
DECLARE
  required_tables TEXT[] := ARRAY[
    'vendors',
    'vendor_slots',
    'slot_holds',
    'vendor_documents',
    'otp_challenges',
    'order_events',
    'quotes',
    'payments',
    'order_otps',
    'vendor_employees',
    'vendor_services',
    'vendor_service_rates',
    'vendor_applications',
    'order_assignments',
    'order_lines',
    'order_drafts',
    'service_categories',
    'garment_types'
  ];
  tbl TEXT;
  missing TEXT[] := '{}';
BEGIN
  FOREACH tbl IN ARRAY required_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      missing := array_append(missing, tbl);
    END IF;
  END LOOP;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'LNDRY MIGRATION INTEGRITY CHECK FAILED — missing tables: %', array_to_string(missing, ', ');
  END IF;

  RAISE NOTICE 'LNDRY migration integrity check PASSED — all % required tables exist', array_length(required_tables, 1);
END $$;
