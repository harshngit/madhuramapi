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
    flats INTEGER,
    refuge_flat INTEGER,
    toilets INTEGER,
    user_id UUID REFERENCES auth_users(user_id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'auth_users_project_id_fkey'
    ) THEN
        ALTER TABLE auth_users
        ADD CONSTRAINT auth_users_project_id_fkey
        FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS vendors (
    vendor_id SERIAL PRIMARY KEY,
    vendor_name TEXT NOT NULL,
    vendor_company_name TEXT,
    vendor_email TEXT,
    mobile_number TEXT,
    location TEXT,
    status TEXT CHECK (status IN ('active', 'inactive', 'blocked')) DEFAULT 'active',
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
    challan_no TEXT,
    mir_refrence_no TEXT,
    material_code TEXT,
    inspection_date_time TIMESTAMP,
    client_submission_date DATE,
    refrence_docs_attached TEXT,
    mir_submited BOOLEAN DEFAULT FALSE,
    dynamic_field JSONB DEFAULT '[]'::jsonb,
    items JSONB DEFAULT '[]'::jsonb,
    po_id INTEGER,
    project_id INTEGER REFERENCES projects(project_id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

    CREATE TABLE IF NOT EXISTS itrs (
        itr_id SERIAL PRIMARY KEY,
        project_id INTEGER REFERENCES projects(project_id) ON DELETE CASCADE,
        project_info JSONB DEFAULT '{}'::jsonb,
        itr_header JSONB DEFAULT '{}'::jsonb,
        location JSONB DEFAULT '{}'::jsonb,
        discipline TEXT,
        quantity JSONB DEFAULT '{}'::jsonb,
        description_of_work TEXT,
        work_items JSONB DEFAULT '[]'::jsonb,
        shaft_details JSONB DEFAULT '[]'::jsonb,
        attachments JSONB DEFAULT '{}'::jsonb,
        part_a_contractor JSONB DEFAULT '{}'::jsonb,
        part_b_lodha_pmc JSONB DEFAULT '{}'::jsonb,
        status TEXT,
        allowed_values JSONB DEFAULT '{}'::jsonb,
        itr_ref_no TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

ALTER TABLE itrs
ADD COLUMN IF NOT EXISTS project_info JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS itr_header JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS location JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS discipline TEXT,
ADD COLUMN IF NOT EXISTS quantity JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS description_of_work TEXT,
ADD COLUMN IF NOT EXISTS work_items JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS shaft_details JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS part_a_contractor JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS part_b_lodha_pmc JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS status TEXT,
ADD COLUMN IF NOT EXISTS allowed_values JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS itr_ref_no TEXT;

CREATE INDEX IF NOT EXISTS idx_itrs_project_id ON itrs(project_id);
CREATE INDEX IF NOT EXISTS idx_itrs_itr_ref_no_lower ON itrs(LOWER(itr_ref_no));

CREATE TABLE IF NOT EXISTS samples (
    sample_id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(project_id) ON DELETE CASCADE,
    building_name TEXT,
    site_name TEXT,
    location JSONB,
    work_done TEXT,
    item_description JSONB DEFAULT '[]'::jsonb,
    add_fields JSONB DEFAULT '[]'::jsonb,
    sample_file TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_requisitions (
    pr_id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(project_id) ON DELETE CASCADE,
    sample_id INTEGER REFERENCES samples(sample_id) ON DELETE SET NULL,
    project_name TEXT,
    workorder_no TEXT,
    location TEXT,
    mirno TEXT,
    urgency TEXT,
    date DATE,
    approved_by TEXT,
    pr_file_path TEXT,
    signature_file_path TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_requisition_items (
    pr_item_id SERIAL PRIMARY KEY,
    pr_id INTEGER REFERENCES purchase_requisitions(pr_id) ON DELETE CASCADE,
    material_description TEXT,
    unit TEXT,
    req_qty NUMERIC,
    make TEXT,
    place_of_utilisation TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pr_project_id ON purchase_requisitions(project_id);
CREATE INDEX IF NOT EXISTS idx_pr_sample_id ON purchase_requisitions(sample_id);
CREATE INDEX IF NOT EXISTS idx_pr_items_pr_id ON purchase_requisition_items(pr_id);

CREATE TABLE IF NOT EXISTS pos (
    po_id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(project_id) ON DELETE CASCADE,
    sample_id INTEGER REFERENCES samples(sample_id) ON DELETE SET NULL,
    company_name TEXT,
    company_subtitle TEXT,
    company_email TEXT,
    company_gst TEXT,
    indent_no TEXT,
    indent_date DATE,
    order_no TEXT,
    po_date DATE,
    vendor_name TEXT,
    site TEXT,
    contact_person TEXT,
    vendor_address TEXT,
    primary_contact_name TEXT,
    primary_contact_number TEXT,
    secondary_contact_number TEXT,
    secondary_contact_name TEXT,
    items JSONB DEFAULT '[]'::jsonb,
    discount NUMERIC,
    discount_amount NUMERIC,
    after_discount NUMERIC,
    cgst NUMERIC,
    cgst_amount NUMERIC,
    sgst NUMERIC,
    sgst_amount NUMERIC,
    total_amount NUMERIC,
    delivery TEXT,
    payment TEXT,
    notes TEXT,
    status TEXT DEFAULT 'created',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS delivery_challans (
    dc_id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(project_id) ON DELETE CASCADE,
    po_id INTEGER REFERENCES pos(po_id) ON DELETE CASCADE,
    po_number TEXT,
    challan_number TEXT,
    items JSONB DEFAULT '[]'::jsonb,
    challan_date DATE,
    work_order_number TEXT,
    order_date DATE,
    total_po_items INTEGER,
    total_challan_items INTEGER,
    status TEXT CHECK (status IN ('incomplete','completed')) DEFAULT 'incomplete',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'mirs_po_id_fkey'
    ) THEN
        ALTER TABLE mirs
        ADD CONSTRAINT mirs_po_id_fkey
        FOREIGN KEY (po_id) REFERENCES pos(po_id) ON DELETE SET NULL;
    END IF;
END $$;

-- Migration to add flats, refuge_flat, and toilets to projects table
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'flats') THEN
        ALTER TABLE projects ADD COLUMN flats INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'refuge_flat') THEN
        ALTER TABLE projects ADD COLUMN refuge_flat INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'toilets') THEN
        ALTER TABLE projects ADD COLUMN toilets INTEGER;
    END IF;
END $$;
