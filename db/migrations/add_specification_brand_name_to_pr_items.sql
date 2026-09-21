-- Add specification and brand_name to purchase_requisition_items
-- (mirrors the same fields already present on samples/installation item lines)

ALTER TABLE purchase_requisition_items
ADD COLUMN IF NOT EXISTS specification TEXT,
ADD COLUMN IF NOT EXISTS brand_name TEXT;
