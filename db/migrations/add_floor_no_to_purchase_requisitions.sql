-- Add floor_no column to purchase_requisitions table
ALTER TABLE purchase_requisitions
ADD COLUMN IF NOT EXISTS floor_no TEXT;
