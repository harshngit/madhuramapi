-- Add item_no column to purchase_requisition_items
-- (stores the item number exactly as sent by the client, independent of
--  boq_item_code which is looked up live from the linked BOQ item)

ALTER TABLE purchase_requisition_items
ADD COLUMN IF NOT EXISTS item_no TEXT;
