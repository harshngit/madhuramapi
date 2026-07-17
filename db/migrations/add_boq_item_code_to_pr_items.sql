-- Add boq_item_code column to purchase_requisition_items
-- (informational field to store BOQ item code for PR items)

ALTER TABLE purchase_requisition_items
ADD COLUMN IF NOT EXISTS boq_item_code TEXT;
