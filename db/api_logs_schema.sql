-- ─────────────────────────────────────────────────────────────────────────────
-- API Logs Schema
-- Tracks every inbound HTTP request to all API endpoints in real-time.
-- Live feed is broadcast via WebSocket (ws://your-server/ws/activity).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS api_logs (
    log_id          SERIAL PRIMARY KEY,
    method          TEXT NOT NULL,                  -- GET | POST | PUT | DELETE | PATCH
    path            TEXT NOT NULL,                  -- e.g. /api/po/12
    status_code     INTEGER,                        -- HTTP response status (200, 201, 404, 500 …)
    duration_ms     INTEGER,                        -- round-trip time in milliseconds
    ip_address      TEXT,                           -- client IP
    user_agent      TEXT,                           -- caller's user-agent string
    user_id         TEXT,                           -- from req.body / req.query (optional)
    user_name       TEXT,                           -- from req.body / req.query (optional)
    request_body    JSONB   DEFAULT '{}'::jsonb,    -- sanitised request payload (passwords stripped)
    response_body   JSONB   DEFAULT '{}'::jsonb,    -- first 2 KB of response body
    error_message   TEXT,                           -- populated on 4xx / 5xx
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_api_logs_created_at   ON api_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_status_code  ON api_logs(status_code);
CREATE INDEX IF NOT EXISTS idx_api_logs_method_path  ON api_logs(method, path);
CREATE INDEX IF NOT EXISTS idx_api_logs_user_id      ON api_logs(user_id);
