-- Schema for Samples
CREATE TABLE IF NOT EXISTS samples (
    sample_id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(project_id) ON DELETE CASCADE,
    building_name TEXT,
    site_name TEXT,
    location JSONB DEFAULT '{}'::jsonb, -- { "floor": "", "block": "", "wing": "", "coordinates": "" }
    work_done TEXT,
    item_description JSONB DEFAULT '[]'::jsonb, -- Array of { "sr_no": 0, "description": "", "quantity": 0, "value": 0, "inventory_id": 0, "issued_qty": 0 }
    add_fields JSONB DEFAULT '[]'::jsonb,
    sample_file TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
