-- The vendor's own post-processing dispatch-time selection (picked after
-- marking an order PACKED). Deliberately separate from
-- scheduled_slot_label/scheduled_delivery_at (053_delivery_slots.sql),
-- which is the customer's checkout-time delivery preference written at
-- order creation — reusing those columns here would silently overwrite
-- the customer's original choice.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS vendor_delivery_slot_label TEXT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS vendor_delivery_slot_at TIMESTAMPTZ NULL;
