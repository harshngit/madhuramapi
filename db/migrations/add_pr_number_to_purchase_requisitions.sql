-- Add pr_number column to purchase_requisitions table
ALTER TABLE purchase_requisitions
ADD COLUMN IF NOT EXISTS pr_number TEXT;
