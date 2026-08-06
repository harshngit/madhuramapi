-- Add quantity column to purchase_requisition_items, mirroring the
-- `quantity` field already used on sample items (item_description[].quantity)

ALTER TABLE purchase_requisition_items
ADD COLUMN IF NOT EXISTS quantity NUMERIC;
