const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const jwt = require("jsonwebtoken");
const { logActivity } = require("./dashboard");
const { sendPushToUsers } = require("../utils/pushHelper");

// ─── JWT helper ───────────────────────────────────────────────────────────────
function getTokenUser(req) {
  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  if (!authHeader) return null;
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

/**
 * @swagger
 * tags:
 *   name: Leave
 *   description: Leave request management
 */

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/leave/apply
// Any non-admin role applies for their own leave
// Body: user_id, name, phone_number, email, address, reason, from_date, to_date
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/leave/apply:
 *   post:
 *     summary: Apply for leave (non-admin users only)
 *     tags: [Leave]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [user_id, name, phone_number, email, address, reason, from_date, to_date]
 *             properties:
 *               user_id:      { type: string, format: uuid }
 *               name:         { type: string }
 *               phone_number: { type: string }
 *               email:        { type: string }
 *               address:      { type: string }
 *               reason:       { type: string }
 *               from_date:    { type: string, format: date }
 *               to_date:      { type: string, format: date }
 *     responses:
 *       201: { description: Leave request submitted }
 *       400: { description: Missing fields or invalid date range }
 *       403: { description: Admins cannot apply via this endpoint }
 */
router.post("/apply", async (req, res) => {
  try {
    const { user_id, name, phone_number, email, address, reason, from_date, to_date } = req.body;

    if (!user_id || !name || !phone_number || !email || !address || !reason || !from_date || !to_date) {
      return res.status(400).json({ error: "All fields are required: user_id, name, phone_number, email, address, reason, from_date, to_date" });
    }

    if (new Date(to_date) < new Date(from_date)) {
      return res.status(400).json({ error: "to_date cannot be before from_date" });
    }

    // Verify user is not admin
    const userRes = await pool.query("SELECT role FROM auth_users WHERE user_id = $1", [user_id]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    if (userRes.rows[0].role === "admin") {
      return res.status(403).json({ error: "Admins cannot apply for leave via this endpoint" });
    }

    const result = await pool.query(
      `INSERT INTO leave_requests
         (user_id, name, phone_number, email, address, reason, from_date, to_date, applied_by, leave_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'self','user_applied')
       RETURNING *`,
      [user_id, name, phone_number, email, address, reason, from_date, to_date]
    );

    res.status(201).json(result.rows[0]);

    logActivity({
      action: "leave_applied",
      entity_type: "leave",
      entity_id: result.rows[0].leave_id,
      entity_name: `Leave request by ${name}`,
      performed_by: user_id,
      performed_by_name: name,
      meta: { from_date, to_date, reason }
    });
  } catch (error) {
    console.error("Apply leave error:", error);
    res.status(500).json({ error: "Failed to submit leave request" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/leave/admin/grant
// Admin grants leave to another user
// Requires Bearer token (admin only)
// Body: user_id, user_name, from_date, to_date, reason
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/leave/admin/grant:
 *   post:
 *     summary: Admin grants leave to a user (admin only, requires Bearer token)
 *     tags: [Leave]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [user_id, user_name, from_date, to_date, reason]
 *             properties:
 *               user_id:   { type: string, format: uuid }
 *               user_name: { type: string }
 *               from_date: { type: string, format: date }
 *               to_date:   { type: string, format: date }
 *               reason:    { type: string }
 *     responses:
 *       201: { description: Leave granted by admin }
 *       400: { description: Missing fields or invalid date range }
 *       401: { description: Missing or invalid token }
 *       403: { description: Only admins can use this endpoint }
 */
router.post("/admin/grant", async (req, res) => {
  try {
    // Auth: extract admin info from token
    const tokenUser = getTokenUser(req);
    if (!tokenUser) {
      return res.status(401).json({ error: "Authorization token is required" });
    }

    // Verify admin role from DB (don't trust token role alone)
    const adminRes = await pool.query(
      "SELECT user_id, name, email, phone_number, role FROM auth_users WHERE user_id = $1",
      [tokenUser.user_id || tokenUser.id]
    );
    if (adminRes.rows.length === 0 || adminRes.rows[0].role !== "admin") {
      return res.status(403).json({ error: "Only admins can grant leave via this endpoint" });
    }
    const admin = adminRes.rows[0];

    const { user_id, user_name, from_date, to_date, reason } = req.body;
    if (!user_id || !user_name || !from_date || !to_date || !reason) {
      return res.status(400).json({ error: "Required: user_id, user_name, from_date, to_date, reason" });
    }
    if (new Date(to_date) < new Date(from_date)) {
      return res.status(400).json({ error: "to_date cannot be before from_date" });
    }

    // Verify target user exists and is not admin
    const targetRes = await pool.query(
      "SELECT role, phone_number, email FROM auth_users WHERE user_id = $1",
      [user_id]
    );
    if (targetRes.rows.length === 0) {
      return res.status(404).json({ error: "Target user not found" });
    }
    if (targetRes.rows[0].role === "admin") {
      return res.status(400).json({ error: "Cannot grant leave to another admin" });
    }

    const target = targetRes.rows[0];

    const result = await pool.query(
      `INSERT INTO leave_requests
         (user_id, name, phone_number, email, reason, from_date, to_date,
          applied_by, leave_type,
          granted_by_admin_id, granted_by_admin_name,
          granted_by_admin_email, granted_by_admin_phone, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'admin','admin_granted',$8,$9,$10,$11,'approved')
       RETURNING *`,
      [
        user_id, user_name,
        target.phone_number, target.email,
        reason, from_date, to_date,
        admin.user_id, admin.name, admin.email, admin.phone_number,
      ]
    );

    res.status(201).json(result.rows[0]);

    logActivity({
      action: "leave_granted_by_admin",
      entity_type: "leave",
      entity_id: result.rows[0].leave_id,
      entity_name: `Leave granted to ${user_name} by admin ${admin.name}`,
      performed_by: admin.user_id,
      performed_by_name: admin.name,
      meta: { from_date, to_date, reason, target_user_id: user_id }
    });
  } catch (error) {
    console.error("Admin grant leave error:", error);
    res.status(500).json({ error: "Failed to grant leave" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/leave/:leave_id/status
// Admin approves or rejects a user-applied leave
// Requires Bearer token (admin only)
// Body: status ('approved' | 'rejected'), remark (optional)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/leave/{leave_id}/status:
 *   patch:
 *     summary: Admin approves or rejects a leave request (admin only)
 *     tags: [Leave]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: leave_id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [approved, rejected] }
 *               remark: { type: string }
 *     responses:
 *       200: { description: Leave status updated }
 *       400: { description: Invalid status }
 *       401: { description: Unauthorized }
 *       403: { description: Admin only }
 */
router.patch("/:leave_id/status", async (req, res) => {
  try {
    const tokenUser = getTokenUser(req);
    if (!tokenUser) return res.status(401).json({ error: "Authorization token is required" });

    const adminRes = await pool.query(
      "SELECT user_id, name, role FROM auth_users WHERE user_id = $1",
      [tokenUser.user_id || tokenUser.id]
    );
    if (adminRes.rows.length === 0 || adminRes.rows[0].role !== "admin") {
      return res.status(403).json({ error: "Only admins can update leave status" });
    }

    const { status, remark } = req.body;
    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "status must be 'approved' or 'rejected'" });
    }

    const result = await pool.query(
      `UPDATE leave_requests
       SET status = $1, admin_remark = $2,
           reviewed_by_admin_id = $3, reviewed_by_admin_name = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE leave_id = $5 RETURNING *`,
      [status, remark || null, adminRes.rows[0].user_id, adminRes.rows[0].name, req.params.leave_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Leave request not found" });
    }

    res.json(result.rows[0]);

    const leave = result.rows[0];
    const title = status === "approved" ? "Leave Approved" : "Leave Rejected";
    const body = status === "approved"
      ? `Your leave request (${leave.from_date} - ${leave.to_date}) has been approved`
      : `Your leave request (${leave.from_date} - ${leave.to_date}) has been rejected${remark ? ": " + remark : ""}`;

    sendPushToUsers({
      userIds: [leave.user_id],
      title,
      body,
      data: { type: "leave", action: `leave_${status}`, leave_id: String(leave.leave_id) },
    }).catch((e) => console.error("Leave push error:", e.message));

    logActivity({
      action: `leave_${status}`,
      entity_type: "leave",
      entity_id: leave.user_id,
      entity_name: `Leave ${status} for ${leave.name}`,
      performed_by: adminRes.rows[0].user_id,
      performed_by_name: adminRes.rows[0].name,
      meta: { leave_id: leave.leave_id, from_date: leave.from_date, to_date: leave.to_date, remark },
    });
  } catch (error) {
    console.error("Update leave status error:", error);
    res.status(500).json({ error: "Failed to update leave status" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/leave
// All leave requests (admin use); supports ?status= ?leave_type= ?from_date= ?to_date=
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/leave:
 *   get:
 *     summary: Get all leave requests with optional filters
 *     tags: [Leave]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, approved, rejected] }
 *       - in: query
 *         name: leave_type
 *         schema: { type: string, enum: [user_applied, admin_granted] }
 *       - in: query
 *         name: from_date
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to_date
 *         schema: { type: string, format: date }
 *     responses:
 *       200: { description: List of leave requests }
 */
router.get("/", async (req, res) => {
  try {
    const { status, leave_type, from_date, to_date } = req.query;
    let query = "SELECT * FROM leave_requests WHERE 1=1";
    const values = [];
    let p = 1;

    if (status)     { query += ` AND status = $${p++}`;     values.push(status); }
    if (leave_type) { query += ` AND leave_type = $${p++}`; values.push(leave_type); }
    if (from_date)  { query += ` AND from_date >= $${p++}`; values.push(from_date); }
    if (to_date)    { query += ` AND to_date <= $${p++}`;   values.push(to_date); }

    query += " ORDER BY created_at DESC";
    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (error) {
    console.error("Get all leave error:", error);
    res.status(500).json({ error: "Failed to fetch leave requests" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/leave/user/:user_id
// All leave requests for a specific user
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/leave/user/{user_id}:
 *   get:
 *     summary: Get all leave requests for a specific user
 *     tags: [Leave]
 *     parameters:
 *       - in: path
 *         name: user_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Leave requests for the user }
 */
router.get("/user/:user_id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM leave_requests WHERE user_id = $1 ORDER BY created_at DESC",
      [req.params.user_id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Get user leave error:", error);
    res.status(500).json({ error: "Failed to fetch user leave requests" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/leave/:leave_id
// Single leave request by ID
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/leave/{leave_id}:
 *   get:
 *     summary: Get a single leave request by ID
 *     tags: [Leave]
 *     parameters:
 *       - in: path
 *         name: leave_id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Leave request details }
 *       404: { description: Not found }
 */
router.get("/:leave_id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM leave_requests WHERE leave_id = $1",
      [req.params.leave_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Leave request not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Get leave by id error:", error);
    res.status(500).json({ error: "Failed to fetch leave request" });
  }
});

module.exports = router;
