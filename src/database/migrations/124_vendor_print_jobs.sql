-- 124_vendor_print_jobs.sql
--
-- A log of tag/label print requests, ported from epic-laundry-desktop's
-- domain.ts#createLaundryPrintJob. This is a record of "these tags were
-- printed," not a printer driver — actually talking to a physical printer
-- is a client/hardware concern (epic's own hardware.ts is explicitly local
-- device probing, out of scope for a backend the same way), so
-- printer_profile here is just a label the counter app sends, not something
-- this backend resolves to real hardware.

CREATE TABLE IF NOT EXISTS vendor_print_jobs (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id         UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  order_id          UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  document_type     VARCHAR(30) NOT NULL DEFAULT 'GARMENT_TAG' CHECK (document_type IN ('GARMENT_TAG', 'CONTAINER_TAG', 'RECEIPT')),
  garment_unit_ids  UUID[] NOT NULL DEFAULT '{}',
  container_ids     UUID[] NOT NULL DEFAULT '{}',
  printer_profile   VARCHAR(80),
  requested_copies  INTEGER NOT NULL DEFAULT 1 CHECK (requested_copies BETWEEN 1 AND 20),
  status            VARCHAR(10) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PRINTED', 'FAILED')),
  failure_reason    VARCHAR(500),
  created_by        UUID NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_print_jobs_order ON vendor_print_jobs(order_id, created_at DESC);
