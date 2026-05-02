-- ============================================================
-- MIGRATION: Attendance Absent-Limit Support
-- Adds index to speed up the per-user absent count query
-- that blocks check-in / status-update when absences >= 15.
--
-- No schema column changes are needed — the logic is enforced
-- entirely in the application layer (attendance.js).
-- This migration only adds the performance index.
-- ============================================================

-- Index: fast lookup of absent records per user
-- Used by: POST /api/attendance  and  PATCH /api/attendance/:id/status
CREATE INDEX IF NOT EXISTS idx_attendance_user_absent
    ON attendance (user_id, status)
    WHERE status = 'absent';

-- ============================================================
-- Optional: helper view to monitor per-user absent totals
-- Usage: SELECT * FROM vw_user_absent_summary WHERE absent_count >= 15;
-- ============================================================
CREATE OR REPLACE VIEW vw_user_absent_summary AS
SELECT
    a.user_id,
    MAX(a.user_name)                                        AS user_name,
    COUNT(*)  FILTER (WHERE a.status = 'absent')            AS absent_count,
    COUNT(*)  FILTER (WHERE a.status = 'present')           AS present_count,
    COUNT(*)  FILTER (WHERE a.status = 'pending')           AS pending_count,
    COUNT(*)                                                AS total_records,
    CASE WHEN COUNT(*) FILTER (WHERE a.status = 'absent') >= 15
         THEN false ELSE true END                           AS can_mark_attendance
FROM attendance a
GROUP BY a.user_id;
