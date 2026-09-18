-- 113_store_orders_wallet_columns.sql
--
-- Links a store_orders row (a POS counter sale, see 111_store_orders.sql)
-- to the wallet_redemption_requests row that funded part or all of it, once
-- the desktop POS UI (a later phase) starts letting a vendor apply a
-- confirmed redemption as a payment leg on a sale. Deliberately its own
-- migration, only now that wallet_redemption_requests exists — this never
-- forward-references a table that doesn't exist yet.

ALTER TABLE store_orders
  ADD COLUMN IF NOT EXISTS wallet_amount_paise INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wallet_redemption_request_id UUID REFERENCES wallet_redemption_requests(id);
