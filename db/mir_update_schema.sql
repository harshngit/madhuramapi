-- Migration to add po_id and items to mirs table

DO $$
BEGIN
    -- Add po_id column
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'mirs' 
        AND column_name = 'po_id'
    ) THEN
        ALTER TABLE mirs ADD COLUMN po_id INTEGER REFERENCES pos(po_id) ON DELETE SET NULL;
    END IF;

    -- Add items column
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'mirs' 
        AND column_name = 'items'
    ) THEN
        ALTER TABLE mirs ADD COLUMN items JSONB DEFAULT '[]'::jsonb;
    END IF;

    -- Add challan_no column
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'mirs'
        AND column_name = 'challan_no'
    ) THEN
        ALTER TABLE mirs ADD COLUMN challan_no TEXT;
    END IF;
END $$;
