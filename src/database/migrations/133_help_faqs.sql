-- 133_help_faqs.sql
-- Admin-managed FAQ list for the customer app's "Help & FAQs" screen.
-- Managed from the dashboard (Help & FAQs page) via /api/v1/admin/help-faqs and
-- served to customers through the public GET /api/v1/customer/faqs, so edits
-- show up in the app without a new build. The support phone/email shown on the
-- same screen already live in app_settings (support_phone / support_email) and
-- are served by GET /api/v1/customer/support-contact — nothing new is needed
-- for those.

CREATE TABLE IF NOT EXISTS help_faqs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_help_faqs_active_order
  ON help_faqs (is_active, sort_order, created_at);

-- Seed with the four questions that used to be hardcoded in the app, so the
-- screen doesn't go blank the moment the app starts reading from here.
INSERT INTO help_faqs (question, answer, sort_order)
SELECT q, a, o FROM (VALUES
  ('What is the turnaround time for delivery?',
   'Most of our laundry vendors return clothes clean, folded, and ironed within 24 to 48 hours. Estimated delivery dates are shown on your order tracking timeline.', 10),
  ('How do I pay for my order?',
   'LNDRY supports completely secure cashless payments using our built-in Razorpay gateway. You can pay via UPI (GPay, Paytm), Cards, Net Banking, or choose Cash on Delivery.', 20),
  ('Can I cancel my scheduled pickup?',
   'Yes. Pickups can be cancelled free of charge at any time before the delivery partner is dispatched. Tap on your order details and click Cancel.', 30),
  ('What if my clothes are damaged?',
   'We select only certified laundry partners. In case of any dispute or rare garment damage, contact our help support details below, and we will compensate you.', 40)
) AS seed(q, a, o)
WHERE NOT EXISTS (SELECT 1 FROM help_faqs);
