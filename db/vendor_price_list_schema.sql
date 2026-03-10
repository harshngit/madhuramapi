-- Schema for Vendor Price Lists and Items
-- This file defines the structure for storing vendor price list history and details.

-- 1. Table to track Price List Versions (History)
CREATE TABLE IF NOT EXISTS vendor_price_lists (
    price_list_id SERIAL PRIMARY KEY,
    vendor_id INTEGER REFERENCES vendors(vendor_id) ON DELETE CASCADE,
    version_name TEXT, -- e.g., "Jan 2026 Price List"
    status TEXT CHECK (status IN ('active', 'inactive', 'archived')) DEFAULT 'active',
    file_path TEXT, -- Path to the uploaded PDF/Excel file
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Table to store the actual items in each Price List
CREATE TABLE IF NOT EXISTS vendor_price_list_items (
    item_id SERIAL PRIMARY KEY,
    price_list_id INTEGER REFERENCES vendor_price_lists(price_list_id) ON DELETE CASCADE,
    items_name TEXT,
    hsn_code TEXT,
    item_code TEXT,
    category TEXT,
    product_name TEXT,
    size_inch TEXT,
    size_mm TEXT,
    price_per_pic NUMERIC,
    discount_price NUMERIC,
    net_price NUMERIC,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_vpl_vendor_id ON vendor_price_lists(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vpli_price_list_id ON vendor_price_list_items(price_list_id);
CREATE INDEX IF NOT EXISTS idx_vpli_items_name_lower ON vendor_price_list_items (LOWER(items_name));
CREATE INDEX IF NOT EXISTS idx_vpli_product_name_lower ON vendor_price_list_items (LOWER(product_name));
CREATE INDEX IF NOT EXISTS idx_vpli_category_lower ON vendor_price_list_items (LOWER(category));
CREATE INDEX IF NOT EXISTS idx_vpli_item_code_lower ON vendor_price_list_items (LOWER(item_code));

-- 3. Update Vendors table to store array of price_list_ids (as requested)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'vendors' 
        AND column_name = 'price_list_ids'
    ) THEN
        ALTER TABLE vendors ADD COLUMN price_list_ids INTEGER[] DEFAULT '{}';
    END IF;
END $$;

-- 4. Add file_path column if it doesn't exist (for migration)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'vendor_price_lists' 
        AND column_name = 'file_path'
    ) THEN
        ALTER TABLE vendor_price_lists ADD COLUMN file_path TEXT;
    END IF;
END $$;
