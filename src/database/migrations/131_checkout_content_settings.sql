-- Admin-editable checkout copy for the customer app's payment screen
-- (Fees → Advance Payment → Checkout Content in the dashboard). Stored in
-- app_settings like the advance amount itself, edited via the existing
-- PUT /api/v1/admin/settings, and served to customers through
-- GET /api/v1/customer/checkout-content. "{amount}" is replaced by the app
-- with the live advance amount, so these never carry a hardcoded figure.
INSERT INTO app_settings (key, value, description) VALUES
  ('checkout_advance_title', to_jsonb('Pay {amount} now to confirm pickup.'::text), 'Checkout: bold advance-payment headline. {amount} = live advance amount'),
  ('checkout_advance_subtitle', to_jsonb('After the vendor checks your clothes, you''ll pay the rest at delivery.'::text), 'Checkout: normal text under the advance-payment headline'),
  ('checkout_refund_title', to_jsonb('If pickup is not confirmed,'::text), 'Checkout: bold lead-in of the refund message'),
  ('checkout_refund_body', to_jsonb('your {amount} is refunded automatically to your original payment source.'::text), 'Checkout: normal remainder of the refund message. {amount} = live advance amount')
ON CONFLICT (key) DO NOTHING;
