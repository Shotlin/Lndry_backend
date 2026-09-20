-- 144_store_orders_price_breakdown.sql
--
-- The labelled price breakdown of a counter order, computed ONCE by the backend quote at booking
-- and stored with the order, so the POS summary, the printed receipt and the invoice all show the
-- exact same lines:
--   { "charges":   [{ "label": "Additional Charge (5%)", "percent": 5,  "amountPaise": 1950 }],
--     "discounts": [{ "label": "Discount (10%)",         "percent": 10, "amountPaise": 3900 }],
--     "tax":       { "label": "GST", "percent": 18, "amountPaise": 6678 } }
-- The totals columns (subtotal/charges/discount/tax/total) stay the source of the money; this only
-- carries the labels and percentages that the totals alone cannot express. Orders booked before
-- this column exist have NULL and are shown from their totals (Additional Charge / Discount / GST).

ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS price_breakdown JSONB;
