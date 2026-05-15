-- Schema for Vendor Comparison
CREATE TABLE IF NOT EXISTS vendor_comparisons (
    comparison_id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(project_id) ON DELETE CASCADE,
    pricelist JSONB DEFAULT '[]'::jsonb, -- Array of { vendor_name, item_description, total_qty, rate, amount }
    upload_document JSONB DEFAULT '[]'::jsonb, -- Array of { file_name, file_url }
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Migration: Add pr_no column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'vendor_comparisons' AND column_name = 'pr_no') THEN
        ALTER TABLE vendor_comparisons ADD COLUMN pr_no INTEGER REFERENCES purchase_requisitions(pr_id) ON DELETE CASCADE;
    END IF;
END $$;

-- Migration: Remove vendor_name column if it exists (moved to pricelist JSON)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'vendor_comparisons' AND column_name = 'vendor_name') THEN
        ALTER TABLE vendor_comparisons DROP COLUMN vendor_name;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_vc_project_id ON vendor_comparisons(project_id);
CREATE INDEX IF NOT EXISTS idx_vc_pr_no ON vendor_comparisons(pr_no);
