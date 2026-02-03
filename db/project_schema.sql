CREATE TABLE IF NOT EXISTS projects (
    project_id SERIAL PRIMARY KEY,
    project_name TEXT NOT NULL,
    project_startdate DATE,
    client_name TEXT,
    location TEXT,
    floor TEXT,
    estimate_value TEXT,
    wo_number TEXT,
    work_order_file TEXT,
    pr_po_tracking TEXT[],
    samples TEXT[],
    mas_file TEXT,
    ml_management TEXT[],
    user_id UUID REFERENCES auth_users(user_id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS boqs (
    boq_id SERIAL PRIMARY KEY,
    category TEXT,
    item_code TEXT,
    description TEXT,
    floor TEXT,
    unit TEXT,
    quantity NUMERIC,
    rate NUMERIC,
    amount NUMERIC,
    boq_file TEXT,
    project_id INTEGER REFERENCES projects(project_id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS mirs (
    mir_id SERIAL PRIMARY KEY,
    project_name TEXT,
    project_code TEXT,
    client_name TEXT,
    pmc TEXT,
    contractor TEXT,
    vendor_code TEXT,
    mir_refrence_no TEXT,
    material_code TEXT,
    inspection_date_time TIMESTAMP,
    client_submission_date DATE,
    refrence_docs_attached TEXT,
    mir_submited BOOLEAN DEFAULT FALSE,
    dynamic_field JSONB DEFAULT '[]'::jsonb,
    project_id INTEGER REFERENCES projects(project_id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS itrs (
    itr_id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(project_id) ON DELETE CASCADE,
    header_details JSONB DEFAULT '{}'::jsonb,
    contractor_details JSONB DEFAULT '{}'::jsonb,
    mep_clearance JSONB DEFAULT '{}'::jsonb,
    surveyor_clearance JSONB DEFAULT '{}'::jsonb,
    interface_clearance JSONB DEFAULT '{}'::jsonb,
    contract_manager JSONB DEFAULT '{}'::jsonb,
    pmc_comments TEXT,
    engineer_civil JSONB DEFAULT '{}'::jsonb,
    engineer_mep JSONB DEFAULT '{}'::jsonb,
    tower_incharge JSONB DEFAULT '{}'::jsonb,
    qaa_department JSONB DEFAULT '{}'::jsonb,
    result_code TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
