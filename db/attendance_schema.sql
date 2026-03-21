DROP TABLE IF EXISTS attendance CASCADE;

CREATE TABLE IF NOT EXISTS attendance (
    attendance_id SERIAL PRIMARY KEY,
    photo_selfie TEXT,
    photo_site TEXT,
    location TEXT,
    latitude NUMERIC,
    longitude NUMERIC,
    user_name TEXT,
    phone_number TEXT,
    date DATE,
    day TEXT,
    project_id INTEGER REFERENCES projects(project_id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_attendance_project_id ON attendance(project_id);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
