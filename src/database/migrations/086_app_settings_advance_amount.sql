-- Configurable advance amount, admin-adjustable via the existing
-- PUT /api/v1/admin/settings — no hardcoded magic number in application code.
INSERT INTO app_settings (key, value, description) VALUES
  ('order_advance_amount_paise', '5000', 'Fixed advance (paise) charged online at checkout before vendor confirmation; balance collected at delivery')
ON CONFLICT (key) DO NOTHING;
