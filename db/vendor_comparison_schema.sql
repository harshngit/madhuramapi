-- Schema for Vendor Comparison
CREATE TABLE IF NOT EXISTS vendor_comparisons (
    comparison_id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(project_id) ON DELETE CASCADE,
    vendor_name TEXT NOT NULL,
    pricelist JSONB DEFAULT '[]'::jsonb, -- Array of { item_description, total_qty, rate, amount }
    upload_document JSONB DEFAULT '[]'::jsonb, -- Array of { file_name, file_url }
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vc_project_id ON vendor_comparisons(project_id);
