-- Add invoice_number and invoice_upload to delivery_challans
-- invoice_upload stores a single file URL (see POST /api/dc/upload-invoice)

ALTER TABLE delivery_challans
ADD COLUMN IF NOT EXISTS invoice_number TEXT,
ADD COLUMN IF NOT EXISTS invoice_upload TEXT;
