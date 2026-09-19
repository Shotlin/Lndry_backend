-- Development switch for admin step-up (TOTP) verification on high-risk
-- dashboard actions (fees, advance amount, settings, order overrides).
-- Seeded OFF while 2FA is still being set up — flip it ON from
-- Dashboard → Settings → Security → Two-Step Verification before going
-- live. The 2FA/step-up implementation itself is untouched; this only
-- decides whether requireStepUp enforces it. ON-by-default if the row is
-- ever missing or unreadable (see isStepUpEnforced).
INSERT INTO app_settings (key, value, description) VALUES
  ('admin_step_up_enabled', to_jsonb(false), 'Require authenticator (step-up) verification for high-risk admin actions')
ON CONFLICT (key) DO NOTHING;
