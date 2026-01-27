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
    user_id UUID REFERENCES auth_users(user_id)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
