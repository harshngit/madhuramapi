-- Migration: Add item_no and project_name to boqs table
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'boqs' AND column_name = 'item_no') THEN
        ALTER TABLE boqs ADD COLUMN item_no TEXT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'boqs' AND column_name = 'project_name') THEN
        ALTER TABLE boqs ADD COLUMN project_name TEXT;
    END IF;
END $$;
