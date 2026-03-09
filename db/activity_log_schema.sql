-- Schema for Activity Log and Notifications

CREATE TABLE IF NOT EXISTS activity_log (
    id SERIAL PRIMARY KEY,
    action TEXT NOT NULL,          -- 'created', 'updated', 'deleted', 'uploaded'
    entity_type TEXT NOT NULL,     -- 'vendor', 'po', 'sample', 'mir', 'itr', 'project', 'user', 'inventory', 'price_list', 'boq', 'dc'
    entity_id INTEGER,             -- ID of the entity
    entity_name TEXT,              -- Display name of the entity
    performed_by TEXT,             -- User ID (can be UUID or Int, storing as TEXT for flexibility)
    performed_by_name TEXT,        -- User Name
    project_id INTEGER,            -- Related Project ID
    meta JSONB DEFAULT '{}'::jsonb, -- Extra details
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,         -- Recipient User ID
    user_name TEXT,                -- Recipient Name
    action TEXT,
    entity_type TEXT,
    entity_id INTEGER,
    entity_name TEXT,
    project_id INTEGER,
    message TEXT,
    is_read BOOLEAN DEFAULT FALSE,
    meta JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_activity_performed_by ON activity_log(performed_by);
CREATE INDEX IF NOT EXISTS idx_activity_project_id ON activity_log(project_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
