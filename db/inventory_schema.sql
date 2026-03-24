-- Schema for Inventory
-- This file defines the structure for storing inventory items.

-- Drop the old table and recreate it to ensure all constraints are removed.
-- This is a destructive operation, but for development it's the cleanest way.
DROP TABLE IF EXISTS inventories CASCADE;

-- Table to store inventory items
CREATE TABLE IF NOT EXISTS inventories (
    inventory_id SERIAL PRIMARY KEY,
    brand TEXT,
    quantity NUMERIC,
    name TEXT,
    price NUMERIC,
    stockin BOOLEAN DEFAULT FALSE,
    billing BOOLEAN DEFAULT FALSE,
    units TEXT,
    width NUMERIC,
    height NUMERIC,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
