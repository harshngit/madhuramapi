-- Add site_address column to pos table
ALTER TABLE pos
ADD COLUMN IF NOT EXISTS site_address TEXT;
