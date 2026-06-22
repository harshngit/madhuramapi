-- Add flats column to samples table
ALTER TABLE samples
ADD COLUMN IF NOT EXISTS flats TEXT;

-- Add flat_no column to purchase_requisitions table
ALTER TABLE purchase_requisitions
ADD COLUMN IF NOT EXISTS flat_no TEXT;
