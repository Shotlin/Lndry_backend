-- Migration 066: Add is_open to vendors
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS is_open BOOLEAN DEFAULT true;
