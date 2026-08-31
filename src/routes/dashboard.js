/**
 * routes/dashboard.js
 * ────────────────────────────────────────────────────────────────────────────
 * REST Endpoints:
 *
 *  STATS
 *   GET /api/dashboard/stats                        — overall totals
 *   GET /api/dashboard/stats?project_id=X           — stats by project
 *   GET /api/dashboard/stats?user_id=X              — stats by user
 *
 *  ACTIVITY LOG
 *   GET    /api/dashboard/activity                  — all activity (paginated)
 *   GET    /api/dashboard/activity?user_id=X        — by user
 *   GET    /api/dashboard/activity?project_id=X     — by project
 *   GET    /api/dashboard/activity?entity_type=X&entity_id=Y — full history for one record
 *   DELETE /api/dashboard/activity/:id              — delete one entry
 *
 *  Every section (PR, PO, Sample, Installation, DC, BOQ, Vendor, Vendor
 *  Comparison, MIR, ITR, Quotation, invoices, price list, Projects,
 *  Attendance, Leave) also exposes GET /<section>/:id/history as a
 *  discoverable convenience wrapper around the same activity_log data via
 *  the getEntityHistory() helper exported below.
 *
 *  NOTIFICATIONS
 *   GET    /api/dashboard/notifications?user_id=X          — get user notifications
 *   GET    /api/dashboard/notifications/unread-count?user_id=X — badge count
 *   PUT    /api/dashboard/notifications/:id/read           — mark one read
 *   PUT    /api/dashboard/notifications/read-all?user_id=X — mark all read
 *   DELETE /api/dashboard/notifications/:id                — delete one
 *
 *  WEBSOCKET
 *   ws://your-server/ws/activity  — live feed (NEW_ACTIVITY, NEW_NOTIFICATION)
 */

const express = require("express");
const { pool } = require("../db");
const { sendRolePush } = require("../utils/pushHelper");

const router = express.Router();

// ─── WebSocket client registry ────────────────────────────────────────────────
const wsClients = new Set();

function broadcast(event) {
  const msg = JSON.stringify(event);
  for (const client of wsClients) {
    try {
      if (client.readyState === 1) client.send(msg);
    } catch (_) {}
  }
}

// ─── buildNotificationMessage ─────────────────────────────────────────────────
function buildNotificationMessage(action, entity_type, entity_name) {
  const typeLabel = {
    vendor:  "Vendor",
    po:      "Purchase Order",
    sample:  "Sample",
    mir:     "MIR",
    itr:     "ITR",
    project: "Project",
    user:    "User",
  }[entity_type] || entity_type;

  const name = entity_name ? ` "${entity_name}"` : "";
  const actionLabel = { created: "created", updated: "updated", deleted: "deleted" }[action] || action;
  return `${typeLabel}${name} was ${actionLabel} successfully.`;
}

// ─── logActivity — imported and called by all other route files ───────────────
function logActivity({
  action,            // "created" | "updated" | "deleted"
  entity_type,       // "vendor" | "po" | "sample" | "mir" | "itr" | "project" | "user"
  entity_id,         // record ID
  entity_name,       // display name e.g. "SANT Valves"
  performed_by,      // user_id
  performed_by_name, // user full name
  project_id,        // project this belongs to (optional)
  meta = {},
}) {
  const metaFinal = { ...meta, ...(project_id ? { project_id } : {}) };

  pool.query(
    `INSERT INTO activity_log
       (action, entity_type, entity_id, entity_name, performed_by, performed_by_name, project_id, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [action, entity_type, entity_id || null, entity_name || null,
     performed_by || null, performed_by_name || null, project_id || null,
     JSON.stringify(metaFinal)]
  )
    .then(({ rows }) => {
      broadcast({ type: "NEW_ACTIVITY", data: rows[0] });

      if (performed_by) {
        const message = buildNotificationMessage(action, entity_type, entity_name);
        pool.query(
          `INSERT INTO notifications
             (user_id, user_name, action, entity_type, entity_id, entity_name, project_id, message, meta)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING *`,
          [performed_by, performed_by_name || null, action, entity_type,
           entity_id || null, entity_name || null, project_id || null,
           message, JSON.stringify(metaFinal)]
        )
          .then(({ rows: n }) => broadcast({ type: "NEW_NOTIFICATION", data: n[0] }))
          .catch((e) => console.error("Notification insert error:", e.message));
      }

      // FCM push notification (role-based)
      sendRolePush({
        action, entity_type, entity_id, entity_name,
        performed_by, performed_by_name,
        project_id, meta: metaFinal,
      }).catch((e) => console.error("Push notification error:", e.message));
    })
    .catch((err) => console.error("Activity log error:", err.message));
}

// ─── getEntityHistory — shared by every section's GET /:id/history route ──────
// Returns the full created/updated/deleted trail (who + when) for one record,
// scoped by entity_type (matching what that section passes to logActivity)
// and entity_id (the record's id, string-compared so alphanumeric ids like
// sample_id/installation_id work the same as numeric ones).
async function getEntityHistory(entityType, entityId, { limit = 50, offset = 0 } = {}) {
  const safeLimit  = Math.min(Math.max(parseInt(limit)  || 50, 1), 200);
  const safeOffset = Math.max(parseInt(offset) || 0, 0);

  const [rows, countResult] = await Promise.all([
    pool.query(
      `SELECT * FROM activity_log
        WHERE entity_type = $1 AND entity_id = $2
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4`,
      [entityType, String(entityId), safeLimit, safeOffset]
    ),
    pool.query(
      `SELECT COUNT(*) FROM activity_log WHERE entity_type = $1 AND entity_id = $2`,
      [entityType, String(entityId)]
    ),
  ]);

  return {
    total:   parseInt(countResult.rows[0].count),
    limit:   safeLimit,
    offset:  safeOffset,
    history: rows.rows,
  };
}

/**
 * @swagger
 * components:
 *   schemas:
 *     CreatedUpdatedBy:
 *       type: object
 *       description: |
 *         Present on every module's GET (list) and GET-by-id responses.
 *         Derived from activity_log — created_by/created_by_name come from
 *         the record's earliest 'created' entry, updated_by/updated_by_name
 *         from its latest 'updated' entry (falls back to the creator if the
 *         record was never updated).
 *       properties:
 *         created_by:
 *           type: string
 *           nullable: true
 *           description: user_id of whoever created this record
 *         created_by_name:
 *           type: string
 *           nullable: true
 *         updated_by:
 *           type: string
 *           nullable: true
 *           description: user_id of whoever last updated this record
 *         updated_by_name:
 *           type: string
 *           nullable: true
 */

// ─── attachCreatedUpdatedBy — bulk-enrich rows with created_by / updated_by ───
// Adds { created_by, created_by_name, updated_by, updated_by_name } to every
// row, derived from activity_log (the EARLIEST 'created' action = creator,
// the LATEST 'updated' action = last editor — falls back to the creator if
// the record was never updated). Used by every module's GET (list) and
// GET (by id) endpoints.
//
// One batched query per call (not per row) — safe to use on list endpoints.
// `getId(row)` extracts each row's id in whatever field that table uses
// (pr_id, po_id, sample_id, etc.); ids are string-compared against
// activity_log.entity_id so alphanumeric ids work the same as numeric ones.
async function attachCreatedUpdatedBy(rows, entityType, getId = (r) => r.id) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) return rows;

  const ids = [...new Set(list.map((r) => String(getId(r))).filter(Boolean))];
  if (ids.length === 0) return rows;

  const result = await pool.query(
    `WITH created AS (
       SELECT DISTINCT ON (entity_id) entity_id, performed_by, performed_by_name
         FROM activity_log
        WHERE entity_type = $1 AND entity_id = ANY($2) AND action = 'created'
        ORDER BY entity_id, created_at ASC
     ),
     updated AS (
       SELECT DISTINCT ON (entity_id) entity_id, performed_by, performed_by_name
         FROM activity_log
        WHERE entity_type = $1 AND entity_id = ANY($2) AND action = 'updated'
        ORDER BY entity_id, created_at DESC
     )
     SELECT COALESCE(c.entity_id, u.entity_id) AS entity_id,
            c.performed_by      AS created_by,
            c.performed_by_name AS created_by_name,
            u.performed_by      AS updated_by,
            u.performed_by_name AS updated_by_name
       FROM created c
       FULL OUTER JOIN updated u ON c.entity_id = u.entity_id`,
    [entityType, ids]
  );

  const byId = new Map(result.rows.map((r) => [String(r.entity_id), r]));

  const enriched = list.map((row) => {
    const info = byId.get(String(getId(row)));
    return {
      ...row,
      created_by:        info?.created_by        ?? null,
      created_by_name:   info?.created_by_name   ?? null,
      updated_by:        info?.updated_by        ?? info?.created_by      ?? null,
      updated_by_name:   info?.updated_by_name   ?? info?.created_by_name ?? null,
    };
  });

  return Array.isArray(rows) ? enriched : enriched[0];
}

// ════════════════════════════════════════════════════════════════════════════
// STATS
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/dashboard/stats:
 *   get:
 *     summary: Dashboard stats — overall, by project_id, or by user_id
 *     tags: [Dashboard]
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *       - in: query
 *         name: user_id
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Stats object
 */
router.get("/stats", async (req, res) => {
  const { project_id, user_id } = req.query;
  try {
    let stats = {};

    if (user_id) {
      // Count records this user created (via activity_log)
      const result = await pool.query(
        `SELECT entity_type, COUNT(*) as total
         FROM activity_log
         WHERE performed_by = $1 AND action = 'created'
         GROUP BY entity_type`,
        [user_id]
      );
      const byType = {};
      for (const row of result.rows) byType[row.entity_type] = parseInt(row.total);

      const recent = await pool.query(
        `SELECT COUNT(*) FROM activity_log
         WHERE performed_by = $1 AND created_at >= NOW() - INTERVAL '30 days'`,
        [user_id]
      );

      stats = {
        mode: "user",
        user_id,
        vendors:  byType.vendor  || 0,
        pos:      byType.po      || 0,
        samples:  byType.sample  || 0,
        mirs:     byType.mir     || 0,
        itrs:     byType.itr     || 0,
        activity_last_30_days: parseInt(recent.rows[0].count),
      };

    } else if (project_id) {
      const [v, p, s, m, i] = await Promise.all([
        pool.query("SELECT COUNT(*) FROM vendors WHERE project_id=$1", [project_id]),
        pool.query("SELECT COUNT(*) FROM pos     WHERE project_id=$1", [project_id]),
        pool.query("SELECT COUNT(*) FROM samples WHERE project_id=$1", [project_id]),
        pool.query("SELECT COUNT(*) FROM mirs    WHERE project_id=$1", [project_id]),
        pool.query("SELECT COUNT(*) FROM itrs    WHERE project_id=$1", [project_id]),
      ]);
      const [rv, rp, rs, rm, ri] = await Promise.all([
        pool.query("SELECT COUNT(*) FROM vendors WHERE project_id=$1 AND created_at>=NOW()-INTERVAL '30 days'", [project_id]),
        pool.query("SELECT COUNT(*) FROM pos     WHERE project_id=$1 AND created_at>=NOW()-INTERVAL '30 days'", [project_id]),
        pool.query("SELECT COUNT(*) FROM samples WHERE project_id=$1 AND created_at>=NOW()-INTERVAL '30 days'", [project_id]),
        pool.query("SELECT COUNT(*) FROM mirs    WHERE project_id=$1 AND created_at>=NOW()-INTERVAL '30 days'", [project_id]),
        pool.query("SELECT COUNT(*) FROM itrs    WHERE project_id=$1 AND created_at>=NOW()-INTERVAL '30 days'", [project_id]),
      ]);

      stats = {
        mode: "project",
        project_id,
        vendors: { total: parseInt(v.rows[0].count), last_30_days: parseInt(rv.rows[0].count) },
        pos:     { total: parseInt(p.rows[0].count), last_30_days: parseInt(rp.rows[0].count) },
        samples: { total: parseInt(s.rows[0].count), last_30_days: parseInt(rs.rows[0].count) },
        mirs:    { total: parseInt(m.rows[0].count), last_30_days: parseInt(rm.rows[0].count) },
        itrs:    { total: parseInt(i.rows[0].count), last_30_days: parseInt(ri.rows[0].count) },
      };

    } else {
      const [v, p, s, m, i, u] = await Promise.all([
        pool.query("SELECT COUNT(*) FROM vendors"),
        pool.query("SELECT COUNT(*) FROM pos"),
        pool.query("SELECT COUNT(*) FROM samples"),
        pool.query("SELECT COUNT(*) FROM mirs"),
        pool.query("SELECT COUNT(*) FROM itrs"),
        pool.query("SELECT COUNT(*) FROM auth_users"),
      ]);
      const [rv, rp, rs, rm, ri] = await Promise.all([
        pool.query("SELECT COUNT(*) FROM vendors WHERE created_at>=NOW()-INTERVAL '30 days'"),
        pool.query("SELECT COUNT(*) FROM pos     WHERE created_at>=NOW()-INTERVAL '30 days'"),
        pool.query("SELECT COUNT(*) FROM samples WHERE created_at>=NOW()-INTERVAL '30 days'"),
        pool.query("SELECT COUNT(*) FROM mirs    WHERE created_at>=NOW()-INTERVAL '30 days'"),
        pool.query("SELECT COUNT(*) FROM itrs    WHERE created_at>=NOW()-INTERVAL '30 days'"),
      ]);

      stats = {
        mode: "overall",
        vendors: { total: parseInt(v.rows[0].count), last_30_days: parseInt(rv.rows[0].count) },
        pos:     { total: parseInt(p.rows[0].count), last_30_days: parseInt(rp.rows[0].count) },
        samples: { total: parseInt(s.rows[0].count), last_30_days: parseInt(rs.rows[0].count) },
        mirs:    { total: parseInt(m.rows[0].count), last_30_days: parseInt(rm.rows[0].count) },
        itrs:    { total: parseInt(i.rows[0].count), last_30_days: parseInt(ri.rows[0].count) },
        users:   { total: parseInt(u.rows[0].count) },
      };
    }

    return res.json({ success: true, stats });
  } catch (err) {
    console.error("Stats error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ACTIVITY LOG
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/dashboard/activity:
 *   get:
 *     summary: Activity log — filter by user_id, project_id, entity_type, action
 *     tags: [Dashboard]
 *     parameters:
 *       - in: query
 *         name: user_id
 *         schema:
 *           type: string
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *       - in: query
 *         name: entity_type
 *         schema:
 *           type: string
 *         description: "vendor | po | sample | mir | itr | project | user"
 *       - in: query
 *         name: entity_id
 *         schema:
 *           type: string
 *         description: "Combine with entity_type to get the full history for one specific record"
 *       - in: query
 *         name: action
 *         schema:
 *           type: string
 *         description: "created | updated | deleted"
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Activity list
 */
router.get("/activity", async (req, res) => {
  try {
    const limit      = Math.min(parseInt(req.query.limit)  || 20, 100);
    const offset     = parseInt(req.query.offset) || 0;
    const user_id    = req.query.user_id    || null;
    const project_id = req.query.project_id || null;
    const entityType = req.query.entity_type || null;
    const entityId   = req.query.entity_id   || null;
    const action     = req.query.action      || null;

    const conditions = [];
    const values     = [];

    if (user_id)    { values.push(user_id);    conditions.push(`performed_by = $${values.length}`); }
    if (project_id) { values.push(project_id); conditions.push(`project_id = $${values.length}`); }
    if (entityType) { values.push(entityType); conditions.push(`entity_type = $${values.length}`); }
    if (entityId)   { values.push(entityId);   conditions.push(`entity_id = $${values.length}`); }
    if (action)     { values.push(action);     conditions.push(`action = $${values.length}`); }

    const where       = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const countValues = [...values];
    values.push(limit, offset);

    const [rows, countResult] = await Promise.all([
      pool.query(
        `SELECT * FROM activity_log ${where} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values
      ),
      pool.query(`SELECT COUNT(*) FROM activity_log ${where}`, countValues),
    ]);

    return res.json({
      success: true,
      total:   parseInt(countResult.rows[0].count),
      limit,
      offset,
      activities: rows.rows,
    });
  } catch (err) {
    console.error("Activity fetch error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @swagger
 * /api/dashboard/activity/{id}:
 *   delete:
 *     summary: Delete an activity log entry
 *     tags: [Dashboard]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Deleted
 */
router.delete("/activity/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM activity_log WHERE id = $1", [req.params.id]);
    return res.json({ success: true, message: "Activity deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/dashboard/notifications:
 *   get:
 *     summary: Get notifications for a user
 *     tags: [Dashboard]
 *     parameters:
 *       - in: query
 *         name: user_id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: is_read
 *         schema:
 *           type: boolean
 *         description: "true = only read, false = only unread"
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Notifications list
 */
router.get("/notifications", async (req, res) => {
  try {
    const { user_id, is_read } = req.query;
    const limit  = Math.min(parseInt(req.query.limit)  || 20, 100);
    const offset = parseInt(req.query.offset) || 0;

    if (!user_id) return res.status(400).json({ success: false, error: "user_id is required" });

    const conditions = ["user_id = $1"];
    const values     = [user_id];

    if (is_read !== undefined && is_read !== "") {
      values.push(is_read === "true");
      conditions.push(`is_read = $${values.length}`);
    }

    const where       = `WHERE ${conditions.join(" AND ")}`;
    const countValues = [...values];
    values.push(limit, offset);

    const [rows, countResult, unreadResult] = await Promise.all([
      pool.query(
        `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values
      ),
      pool.query(`SELECT COUNT(*) FROM notifications ${where}`, countValues),
      pool.query("SELECT COUNT(*) FROM notifications WHERE user_id=$1 AND is_read=false", [user_id]),
    ]);

    return res.json({
      success:       true,
      total:         parseInt(countResult.rows[0].count),
      unread_count:  parseInt(unreadResult.rows[0].count),
      limit,
      offset,
      notifications: rows.rows,
    });
  } catch (err) {
    console.error("Notifications fetch error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @swagger
 * /api/dashboard/notifications/unread-count:
 *   get:
 *     summary: Get unread notification count for badge
 *     tags: [Dashboard]
 *     parameters:
 *       - in: query
 *         name: user_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Unread count
 */
router.get("/notifications/unread-count", async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ success: false, error: "user_id is required" });
    const result = await pool.query(
      "SELECT COUNT(*) FROM notifications WHERE user_id=$1 AND is_read=false",
      [user_id]
    );
    return res.json({ success: true, unread_count: parseInt(result.rows[0].count) });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @swagger
 * /api/dashboard/notifications/{id}/read:
 *   put:
 *     summary: Mark a notification as read
 *     tags: [Dashboard]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Marked as read
 */
router.put("/notifications/:id/read", async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE notifications SET is_read=true, read_at=NOW() WHERE id=$1 RETURNING *",
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: "Not found" });
    return res.json({ success: true, notification: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @swagger
 * /api/dashboard/notifications/read-all:
 *   put:
 *     summary: Mark ALL notifications as read for a user
 *     tags: [Dashboard]
 *     parameters:
 *       - in: query
 *         name: user_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: All marked as read
 */
router.put("/notifications/read-all", async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ success: false, error: "user_id is required" });
    const result = await pool.query(
      "UPDATE notifications SET is_read=true, read_at=NOW() WHERE user_id=$1 AND is_read=false",
      [user_id]
    );
    return res.json({ success: true, updated_count: result.rowCount });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @swagger
 * /api/dashboard/notifications/{id}:
 *   delete:
 *     summary: Delete a notification
 *     tags: [Dashboard]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Deleted
 */
router.delete("/notifications/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM notifications WHERE id=$1", [req.params.id]);
    return res.json({ success: true, message: "Notification deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// WEBSOCKET HANDLER
// ════════════════════════════════════════════════════════════════════════════
function wsHandler(ws) {
  wsClients.add(ws);
  console.log(`[WS] Client connected. Total: ${wsClients.size}`);

  pool.query("SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 10")
    .then(({ rows }) => {
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ type: "INITIAL_ACTIVITIES", data: rows.reverse() }));
    })
    .catch(() => {});

  ws.on("close", () => { wsClients.delete(ws); console.log(`[WS] Disconnected. Total: ${wsClients.size}`); });
  ws.on("error", () => wsClients.delete(ws));
  ws.on("message", (msg) => {
    try {
      const p = JSON.parse(msg);
      if (p.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    } catch (_) {}
  });
}

module.exports = {
  router,
  logActivity,
  getEntityHistory,
  attachCreatedUpdatedBy,
  wsHandler,
  broadcast
};