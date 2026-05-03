-- ============================================================
-- SCHEMA: leave_requests
-- Handles both user-applied leaves and admin-granted leaves
-- ============================================================

CREATE TABLE IF NOT EXISTS leave_requests (
    leave_id                 SERIAL PRIMARY KEY,

    -- Who is the leave for
    user_id                  UUID NOT NULL REFERENCES auth_users(user_id) ON DELETE CASCADE,
    name                     TEXT NOT NULL,
    phone_number             TEXT NOT NULL,
    email                    TEXT NOT NULL,
    address                  TEXT,                        -- required for user_applied, null ok for admin_granted

    -- Leave details
    reason                   TEXT NOT NULL,
    from_date                DATE NOT NULL,
    to_date                  DATE NOT NULL,

    -- Type & status
    leave_type               TEXT NOT NULL DEFAULT 'user_applied'
                               CHECK (leave_type IN ('user_applied', 'admin_granted')),
    applied_by               TEXT NOT NULL DEFAULT 'self'
                               CHECK (applied_by IN ('self', 'admin')),
    status                   TEXT NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'approved', 'rejected')),

    -- Admin who GRANTED the leave (only for admin_granted type)
    granted_by_admin_id      UUID REFERENCES auth_users(user_id) ON DELETE SET NULL,
    granted_by_admin_name    TEXT,
    granted_by_admin_email   TEXT,
    granted_by_admin_phone   TEXT,

    -- Admin who REVIEWED a user-applied leave request
    reviewed_by_admin_id     UUID REFERENCES auth_users(user_id) ON DELETE SET NULL,
    reviewed_by_admin_name   TEXT,
    admin_remark             TEXT,

    created_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_leave_user_id    ON leave_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_leave_status     ON leave_requests(status);
CREATE INDEX IF NOT EXISTS idx_leave_from_date  ON leave_requests(from_date);
CREATE INDEX IF NOT EXISTS idx_leave_type       ON leave_requests(leave_type);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION set_leave_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS leave_requests_set_updated_at ON leave_requests;
CREATE TRIGGER leave_requests_set_updated_at
BEFORE UPDATE ON leave_requests
FOR EACH ROW EXECUTE PROCEDURE set_leave_updated_at();
