-- Schema for Inventory
-- This file defines the structure for storing inventory items.

-- Table to store inventory items
CREATE TABLE IF NOT EXISTS inventories (
    inventory_id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(project_id) ON DELETE CASCADE,
    brand TEXT,
    quantity NUMERIC,
    name TEXT,
    price NUMERIC,
    stockin BOOLEAN DEFAULT FALSE,
    billing BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_inv_project_id ON inventories(project_id);

-- Add billing column if it doesn't exist (for migration)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'inventories' 
        AND column_name = 'billing'
    ) THEN
        ALTER TABLE inventories ADD COLUMN billing BOOLEAN DEFAULT FALSE;
    END IF;
END $$;
