CREATE TABLE IF NOT EXISTS projects (
    project_id SERIAL PRIMARY KEY,
    project_name TEXT NOT NULL,
    product_duration DATE,
    client_name TEXT,
    work_order_file TEXT,
    work_order_information TEXT,
    pr_po_tracking TEXT[],
    samples TEXT[],
    mas_file TEXT,
    ml_management TEXT[],
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
