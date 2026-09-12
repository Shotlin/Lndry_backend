-- Migration 104: Add a real device-model column to `devices`.
--
-- `devices.platform` only ever stored 'ios'/'android'/'web' — enough to
-- know the OS, never which physical device ("iPhone 15 Pro", or the raw
-- Android model string). Customer-app support for populating this ships
-- alongside this migration (see Lndry_app's auth flow) — existing rows
-- stay NULL until that customer's next login.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_model VARCHAR(150);
