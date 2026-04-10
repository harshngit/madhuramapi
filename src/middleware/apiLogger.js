/**
 * middleware/apiLogger.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Express middleware that logs EVERY inbound HTTP request to the `api_logs`
 * table and broadcasts a live WS event (type: "NEW_API_LOG") so the
 * developer dashboard can show a real-time request feed.
 *
 * Usage in index.js — register BEFORE your route handlers:
 *
 *   const { apiLogger } = require("./middleware/apiLogger");
 *   app.use(apiLogger);
 *
 * Sensitive keys (password, token, secret, …) are stripped from the
 * request body before storage so credentials never land in the logs.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { pool }    = require("../db");
const { broadcast } = require("../routes/dashboard");

// Keys whose values will be replaced with "***REDACTED***" before storage
const SENSITIVE_KEYS = new Set([
  "password", "pass", "token", "secret", "authorization",
  "api_key", "apikey", "access_token", "refresh_token",
  "otp", "pin", "cvv",
]);

/**
 * Recursively redact sensitive fields from an object/array.
 * Returns a new object — does NOT mutate the original.
 */
function redact(obj, depth = 0) {
  if (depth > 6 || obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(item => redact(item, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? "***REDACTED***" : redact(v, depth + 1);
  }
  return out;
}

/**
 * Truncate a stringified JSON value to ~2 KB so we don't fill the DB
 * with huge PDF/binary bodies.
 */
function safeJson(val, maxChars = 2000) {
  try {
    const str = JSON.stringify(val);
    if (!str || str.length <= maxChars) return val;
    return { _truncated: true, preview: str.slice(0, maxChars) };
  } catch {
    return { _error: "non-serialisable" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Paths to skip entirely (health-check, static assets, docs)
// ─────────────────────────────────────────────────────────────────────────────
const SKIP_PREFIXES = ["/health", "/docs", "/uploads", "/favicon"];

function shouldSkip(path) {
  return SKIP_PREFIXES.some(p => path.startsWith(p));
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────────
function apiLogger(req, res, next) {
  if (shouldSkip(req.path)) return next();

  const startedAt = Date.now();

  // Capture the response body by monkey-patching res.json / res.send
  let capturedBody = null;

  const originalJson = res.json.bind(res);
  res.json = function (body) {
    capturedBody = body;
    return originalJson(body);
  };

  const originalSend = res.send.bind(res);
  res.send = function (body) {
    if (capturedBody === null) {
      // Only capture text-like responses, not binary (PDF etc.)
      const ct = res.getHeader("content-type") || "";
      if (ct.includes("json") || ct.includes("text")) {
        try { capturedBody = JSON.parse(body); } catch { capturedBody = String(body).slice(0, 500); }
      }
    }
    return originalSend(body);
  };

  res.on("finish", () => {
    const duration  = Date.now() - startedAt;
    const status    = res.statusCode;
    const method    = req.method;
    const path      = req.originalUrl || req.path;
    const ip        = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
    const userAgent = (req.headers["user-agent"] || "").slice(0, 300);

    // Pull user identity from common places (body / query / headers)
    const userId   = req.body?.user_id   || req.query?.user_id   || req.headers?.["x-user-id"]   || null;
    const userName = req.body?.user_name || req.query?.user_name || req.headers?.["x-user-name"] || null;

    // Build sanitised request body (strip files / huge buffers)
    const rawBody     = typeof req.body === "object" ? req.body : {};
    const cleanBody   = redact(rawBody);
    const safeBody    = safeJson(cleanBody);

    // Build sanitised response body
    const safeResp    = safeJson(capturedBody);

    // Error message for 4xx / 5xx
    let errorMessage = null;
    if (status >= 400 && capturedBody) {
      errorMessage = capturedBody?.error || capturedBody?.message || JSON.stringify(capturedBody).slice(0, 500);
    }

    // Insert asynchronously — never block the response
    pool.query(
      `INSERT INTO api_logs
         (method, path, status_code, duration_ms, ip_address, user_agent,
          user_id, user_name, request_body, response_body, error_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        method, path, status, duration, ip, userAgent,
        userId  ? String(userId)   : null,
        userName ? String(userName) : null,
        JSON.stringify(safeBody  ?? {}),
        JSON.stringify(safeResp  ?? {}),
        errorMessage,
      ]
    )
    .then(({ rows }) => {
      // Broadcast to all WebSocket listeners on /ws/activity
      try {
        broadcast({ type: "NEW_API_LOG", data: rows[0] });
      } catch (_) {
        // broadcast may not be ready on very first request — silently ignore
      }
    })
    .catch(err => console.error("[apiLogger] DB insert error:", err.message));
  });

  next();
}

module.exports = { apiLogger };
