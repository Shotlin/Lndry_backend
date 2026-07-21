-- Migration 061: Make order_id nullable in payments table and add order_draft_id
ALTER TABLE payments ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS order_draft_id UUID REFERENCES order_drafts(id) ON DELETE SET NULL;
