/**
 * @swagger
 * tags:
 *   name: Logs
 *   description: API Request and Error Logs
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     ApiLog:
 *       type: object
 *       properties:
 *         log_id:
 *           type: integer
 *         method:
 *           type: string
 *         path:
 *           type: string
 *         status_code:
 *           type: integer
 *         duration_ms:
 *           type: integer
 *         ip_address:
 *           type: string
 *         user_id:
 *           type: string
 *         user_name:
 *           type: string
 *         error_message:
 *           type: string
 *         request_body:
 *           type: object
 *         response_body:
 *           type: object
 *         created_at:
 *           type: string
 *           format: date-time
 */

const express = require("express");
const router  = express.Router();
const { pool } = require("../db");

/**
 * @swagger
 * /api/logs:
 *   get:
 *     summary: Get paginated API logs
 *     tags: [Logs]
 *     parameters:
 *       - in: query
 *         name: method
 *         schema: { type: string }
 *         description: Filter by HTTP method (GET, POST, etc.)
 *       - in: query
 *         name: status
 *         schema: { type: integer }
 *         description: Filter by exact status code
 *       - in: query
 *         name: status_gte
 *         schema: { type: integer }
 *         description: Filter by status code greater than or equal to
 *       - in: query
 *         name: path
 *         schema: { type: string }
 *         description: Partial path match
 *       - in: query
 *         name: user_id
 *         schema: { type: string }
 *         description: Filter by user ID
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *         description: Filter logs from this timestamp
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *         description: Filter logs to this timestamp
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: List of logs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total: { type: integer }
 *                 limit: { type: integer }
 *                 offset: { type: integer }
 *                 rows:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/ApiLog' }
 */
router.get("/", async (req, res) => {
  try {
    const {
      method, status, status_gte, path: pathFilter,
      user_id, from, to,
      limit = 50, offset = 0,
    } = req.query;

    const conditions = [];
    const params     = [];
    let   p          = 1;

    if (method) {
      conditions.push(`method = $${p++}`);
      params.push(method.toUpperCase());
    }
    if (status) {
      conditions.push(`status_code = $${p++}`);
      params.push(Number(status));
    }
    if (status_gte) {
      conditions.push(`status_code >= $${p++}`);
      params.push(Number(status_gte));
    }
    if (pathFilter) {
      conditions.push(`path ILIKE $${p++}`);
      params.push(`%${pathFilter}%`);
    }
    if (user_id) {
      conditions.push(`user_id = $${p++}`);
      params.push(user_id);
    }
    if (from) {
      conditions.push(`created_at >= $${p++}`);
      params.push(new Date(from));
    }
    if (to) {
      conditions.push(`created_at <= $${p++}`);
      params.push(new Date(to));
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const lim   = Math.min(Number(limit) || 50, 200);
    const off   = Number(offset) || 0;

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT log_id, method, path, status_code, duration_ms,
                ip_address, user_id, user_name, error_message, created_at
           FROM api_logs
           ${where}
           ORDER BY created_at DESC
           LIMIT $${p} OFFSET $${p + 1}`,
        [...params, lim, off]
      ),
      pool.query(`SELECT COUNT(*)::int AS total FROM api_logs ${where}`, params),
    ]);

    res.json({
      total:  countRes.rows[0].total,
      limit:  lim,
      offset: off,
      rows:   dataRes.rows,
    });
  } catch (err) {
    console.error("[api_logs GET /]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/logs/stats:
 *   get:
 *     summary: Get aggregate statistics for API logs
 *     tags: [Logs]
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Aggregate stats
 */
router.get("/stats", async (req, res) => {
  try {
    const { from, to } = req.query;
    const conditions = [];
    const params     = [];
    let p = 1;

    if (from) { conditions.push(`created_at >= $${p++}`); params.push(new Date(from)); }
    if (to)   { conditions.push(`created_at <= $${p++}`); params.push(new Date(to));   }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [totals, byMethod, byStatus, slowest, topPaths, recentErrors] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int                                        AS total_requests,
           COUNT(*) FILTER (WHERE status_code < 400)::int      AS success_count,
           COUNT(*) FILTER (WHERE status_code >= 400)::int     AS error_count,
           COUNT(*) FILTER (WHERE status_code >= 500)::int     AS server_error_count,
           ROUND(AVG(duration_ms))::int                        AS avg_duration_ms,
           MAX(duration_ms)::int                               AS max_duration_ms
         FROM api_logs ${where}`, params
      ),
      pool.query(
        `SELECT method, COUNT(*)::int AS count
           FROM api_logs ${where}
           GROUP BY method ORDER BY count DESC`, params
      ),
      pool.query(
        `SELECT status_code, COUNT(*)::int AS count
           FROM api_logs ${where}
           GROUP BY status_code ORDER BY status_code`, params
      ),
      pool.query(
        `SELECT log_id, method, path, status_code, duration_ms, created_at
           FROM api_logs ${where}
           ORDER BY duration_ms DESC NULLS LAST LIMIT 5`, params
      ),
      pool.query(
        `SELECT path,
                COUNT(*)::int                                    AS total,
                COUNT(*) FILTER (WHERE status_code >= 400)::int  AS errors,
                ROUND(AVG(duration_ms))::int                     AS avg_ms
           FROM api_logs ${where}
           GROUP BY path
           ORDER BY total DESC
           LIMIT 10`, params
      ),
      pool.query(
        `SELECT log_id, method, path, status_code, error_message, created_at
           FROM api_logs
           WHERE status_code >= 400
           ${conditions.length ? "AND " + conditions.join(" AND ") : ""}
           ORDER BY created_at DESC
           LIMIT 10`,
        params
      ),
    ]);

    res.json({
      summary:       totals.rows[0],
      by_method:     byMethod.rows,
      by_status:     byStatus.rows,
      slowest:       slowest.rows,
      top_paths:     topPaths.rows,
      recent_errors: recentErrors.rows,
    });
  } catch (err) {
    console.error("[api_logs GET /stats]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/logs/{id}:
 *   get:
 *     summary: Get single log entry detail (includes request/response bodies)
 *     tags: [Logs]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Full log entry
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiLog' }
 *       404:
 *         description: Not found
 */
router.get("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM api_logs WHERE log_id = $1",
      [req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Log entry not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("[api_logs GET /:id]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/logs/{id}:
 *   delete:
 *     summary: Delete a single log entry
 *     tags: [Logs]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Log deleted
 */
router.delete("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM api_logs WHERE log_id = $1 RETURNING log_id",
      [req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Log entry not found" });
    res.json({ message: "Log entry deleted", log_id: result.rows[0].log_id });
  } catch (err) {
    console.error("[api_logs DELETE /:id]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/logs:
 *   delete:
 *     summary: Purge all logs (DANGER)
 *     tags: [Logs]
 *     responses:
 *       200:
 *         description: Logs purged
 */
router.delete("/", async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM api_logs RETURNING log_id");
    res.json({ message: `${result.rowCount} log entries purged` });
  } catch (err) {
    console.error("[api_logs DELETE /]", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
