const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { logActivity, getEntityHistory, attachCreatedUpdatedBy } = require("./dashboard");

// ─── Upload Directory Setup ───────────────────────────────────────────────────
const uploadDir = path.join(__dirname, "../../uploads/attendance");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({ storage: storage });

/**
 * @swagger
 * components:
 *   schemas:
 *     Attendance:
 *       type: object
 *       properties:
 *         attendance_id:
 *           type: integer
 *         photo_selfie:
 *           type: string
 *         photo_site:
 *           type: string
 *         location:
 *           type: string
 *         latitude:
 *           type: number
 *         longitude:
 *           type: number
 *         user_name:
 *           type: string
 *         phone_number:
 *           type: string
 *         date:
 *           type: string
 *           format: date
 *         day:
 *           type: string
 *         project_id:
 *           type: integer
 *         user_id:
 *           type: string
 *           format: uuid
 *         status:
 *           type: string
 *           enum: [pending, present, absent, half_day]
 *         check_out_time:
 *           type: string
 *           format: date-time
 *         check_out_photo_selfie:
 *           type: string
 *         check_out_photo_site:
 *           type: string
 *         check_out_location:
 *           type: string
 *         check_out_latitude:
 *           type: number
 *         check_out_longitude:
 *           type: number
 *         remark:
 *           type: string
 *         created_at:
 *           type: string
 *           format: date-time
 *         updated_at:
 *           type: string
 *           format: date-time
 */

/**
 * @swagger
 * tags:
 *   name: Attendance
 *   description: |
 *     Attendance management API. Every GET (list/by-id/by-project/by-user)
 *     response also includes
 *     created_by/created_by_name/updated_by/updated_by_name — see the
 *     CreatedUpdatedBy schema.
 */

/**
 * @swagger
 * /api/attendance/upload:
 *   post:
 *     summary: Upload an image for attendance (selfie or site photo)
 *     tags: [Attendance]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: File uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 filePath:
 *                   type: string
 *       400:
 *         description: No file uploaded
 */
router.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  const filePath = `/uploads/attendance/${req.file.filename}`;
  res.json({ filePath });

  if (req.body.user_id) {
    logActivity({
      action: "uploaded",
      entity_type: "attendance_photo",
      entity_id: null,
      entity_name: req.file.originalname,
      performed_by: req.body.user_id,
      performed_by_name: req.body.user_name || null,
      meta: { filePath }
    });
  }
});

/**
 * @swagger
 * /api/attendance:
 *   post:
 *     summary: Create a new attendance record (check-in)
 *     tags: [Attendance]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               photo_selfie: { type: string }
 *               photo_site: { type: string }
 *               location: { type: string }
 *               latitude: { type: number }
 *               longitude: { type: number }
 *               user_name: { type: string }
 *               phone_number: { type: string }
 *               date: { type: string, format: date }
 *               day: { type: string }
 *               project_id: { type: integer }
 *               user_id: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: Attendance record created
 *       403:
 *         description: User is blocked
 *       500:
 *         description: Server error
 */
router.post("/", async (req, res) => {
  try {
    const {
      photo_selfie,
      photo_site,
      location,
      latitude,
      longitude,
      user_name,
      phone_number,
      date,
      day,
      project_id,
      user_id,
    } = req.body;

    // ─── BLOCK: Prevent check-in if user is blocked or has 15 absences ───────
    const userCheckResult = await pool.query(
      "SELECT is_blocked, name FROM auth_users WHERE user_id = $1",
      [user_id]
    );

    if (userCheckResult.rows.length > 0) {
      const { is_blocked, name } = userCheckResult.rows[0];
      if (is_blocked) {
        return res.status(403).json({
          error: `Attendance cannot be recorded. ${name || "This user"} is currently blocked.`,
          user_id: user_id,
        });
      }
    }

    // ─────────────────────────────────────────────────────────────────────────

    // Fetch user's designated check-in time for lateness calculation
    const userResult = await pool.query(
      "SELECT check_in_time, role FROM auth_users WHERE user_id = $1",
      [user_id]
    );

    let remark = null;
    if (userResult.rows.length > 0 && userResult.rows[0].role === 'labour' && userResult.rows[0].check_in_time) {
      const designatedCheckIn = userResult.rows[0].check_in_time;
      const now = new Date();
      const [desigH, desigM, desigS] = designatedCheckIn.split(':').map(Number);
      const designatedDate = new Date(now);
      designatedDate.setHours(desigH, desigM, desigS || 0, 0);
      if (now > designatedDate) {
        const diffMins = Math.floor((now - designatedDate) / 60000);
        if (diffMins > 0) {
          remark = `User is late by ${diffMins} minutes`;
        }
      }
    }

    const result = await pool.query(
      `INSERT INTO attendance (
        photo_selfie, photo_site, location, latitude, longitude,
        user_name, phone_number, date, day, project_id, user_id, status, remark
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12) RETURNING *`,
      [photo_selfie, photo_site, location, latitude, longitude,
       user_name, phone_number, date, day, project_id, user_id, remark]
    );

    res.status(201).json(result.rows[0]);

    logActivity({
      action: "created",
      entity_type: "attendance",
      entity_id: result.rows[0].attendance_id,
      entity_name: `Attendance for ${user_name} on ${date}`,
      performed_by: user_id || null,
      performed_by_name: user_name || null,
      meta: { project_id, remark }
    });
  } catch (error) {
    console.error("Create attendance error:", error);
    if (error.code === "23503" && error.constraint === "attendance_project_id_fkey")
      return res.status(400).json({ error: `Invalid project_id: no project with id ${req.body.project_id} exists` });
    res.status(500).json({ error: "Failed to create attendance record" });
  }
});

/**
 * @swagger
 * /api/attendance:
 *   get:
 *     summary: Get all attendance records (with optional filters)
 *     tags: [Attendance]
 *     parameters:
 *       - in: query
 *         name: start_date
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: end_date
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: project_id
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: List of attendance records
 */
router.get("/", async (req, res) => {
  try {
    const { start_date, end_date, status, project_id } = req.query;
    let query = "SELECT * FROM attendance WHERE 1=1";
    const values = [];
    let p = 1;

    if (start_date) { query += ` AND date >= $${p++}`; values.push(start_date); }
    if (end_date)   { query += ` AND date <= $${p++}`; values.push(end_date); }
    if (status)     { query += ` AND status = $${p++}`; values.push(status); }
    if (project_id) { query += ` AND project_id = $${p++}`; values.push(project_id); }

    query += " ORDER BY date DESC, created_at DESC";
    const result = await pool.query(query, values);
    res.json(await attachCreatedUpdatedBy(result.rows, "attendance", (r) => r.attendance_id));
  } catch (error) {
    console.error("Get attendance error:", error);
    res.status(500).json({ error: "Failed to fetch attendance records" });
  }
});

/**
 * @swagger
 * /api/attendance/today/present:
 *   get:
 *     summary: Get today's present count
 *     tags: [Attendance]
 *     responses:
 *       200:
 *         description: Today's present count
 */
router.get("/today/present", async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await pool.query(
      "SELECT COUNT(*) FROM attendance WHERE date = $1 AND status = 'present'",
      [today]
    );
    res.json({ date: today, count: parseInt(result.rows[0].count) });
  } catch (error) {
    console.error("Get today present count error:", error);
    res.status(500).json({ error: "Failed to fetch today's present count" });
  }
});

// ─── HELPER: Build the three attendance lists for a given date/project ────────
async function buildAttendanceSummary(date, project_id) {
  const projectFilterSQL = project_id ? " AND a.project_id = $2" : "";

  // Checked IN — no checkout yet
  const checkedInResult = await pool.query(
    `SELECT a.attendance_id, a.user_id, a.user_name, a.phone_number, a.project_id,
            a.location, a.latitude, a.longitude,
            a.photo_selfie, a.photo_site, a.status, a.remark,
            a.created_at AS check_in_time
     FROM attendance a
     WHERE a.date = $1 AND a.check_out_time IS NULL${projectFilterSQL}
     ORDER BY a.created_at ASC`,
    project_id ? [date, project_id] : [date]
  );

  // Checked IN + OUT
  const checkedOutResult = await pool.query(
    `SELECT a.attendance_id, a.user_id, a.user_name, a.phone_number, a.project_id,
            a.location, a.latitude, a.longitude,
            a.photo_selfie, a.photo_site,
            a.check_out_time, a.check_out_location, a.check_out_latitude, a.check_out_longitude,
            a.check_out_photo_selfie, a.check_out_photo_site,
            a.status, a.remark,
            a.created_at AS check_in_time
     FROM attendance a
     WHERE a.date = $1 AND a.check_out_time IS NOT NULL${projectFilterSQL}
     ORDER BY a.check_out_time ASC`,
    project_id ? [date, project_id] : [date]
  );

  // Not checked in at all today
  let notCheckedInQuery, notCheckedInValues;
  if (project_id) {
    notCheckedInQuery = `
      SELECT DISTINCT u.user_id, u.username AS user_name, u.phone_number, u.role
      FROM auth_users u
      WHERE u.is_active = true
        AND u.user_id NOT IN (
          SELECT DISTINCT a.user_id FROM attendance a
          WHERE a.date = $1 AND a.project_id = $2
        )
      ORDER BY u.username ASC`;
    notCheckedInValues = [date, project_id];
  } else {
    notCheckedInQuery = `
      SELECT u.user_id, u.username AS user_name, u.phone_number, u.role
      FROM auth_users u
      WHERE u.is_active = true
        AND u.user_id NOT IN (
          SELECT DISTINCT a.user_id FROM attendance a WHERE a.date = $1
        )
      ORDER BY u.username ASC`;
    notCheckedInValues = [date];
  }
  const notCheckedInResult = await pool.query(notCheckedInQuery, notCheckedInValues);

  return {
    checked_in: checkedInResult.rows,
    checked_out: checkedOutResult.rows,
    not_checked_in: notCheckedInResult.rows,
  };
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/attendance/today/summary:
 *   get:
 *     summary: Get today's check-in / check-out / not-checked-in lists with counts
 *     tags: [Attendance]
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema: { type: integer }
 *         description: Optional project filter
 *     responses:
 *       200:
 *         description: >
 *           Returns three lists: checked_in (checked in, not yet checked out),
 *           checked_out (fully completed attendance), not_checked_in (users with
 *           no attendance today). Each list has a corresponding count.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 date: { type: string }
 *                 project_id: { type: integer, nullable: true }
 *                 counts:
 *                   type: object
 *                   properties:
 *                     checked_in: { type: integer }
 *                     checked_out: { type: integer }
 *                     not_checked_in: { type: integer }
 *                 checked_in: { type: array, items: { type: object } }
 *                 checked_out: { type: array, items: { type: object } }
 *                 not_checked_in: { type: array, items: { type: object } }
 */
router.get("/today/summary", async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { project_id } = req.query;
    const { checked_in, checked_out, not_checked_in } =
      await buildAttendanceSummary(today, project_id || null);

    res.json({
      date: today,
      project_id: project_id || null,
      counts: {
        checked_in: checked_in.length,
        checked_out: checked_out.length,
        not_checked_in: not_checked_in.length,
      },
      checked_in,
      checked_out,
      not_checked_in,
    });
  } catch (error) {
    console.error("Get today summary error:", error);
    res.status(500).json({ error: "Failed to fetch today's attendance summary" });
  }
});

/**
 * @swagger
 * /api/attendance/summary:
 *   get:
 *     summary: Get check-in / check-out / not-checked-in lists with counts for any date
 *     tags: [Attendance]
 *     parameters:
 *       - in: query
 *         name: date
 *         required: true
 *         schema: { type: string, format: date }
 *         description: Date in YYYY-MM-DD format
 *       - in: query
 *         name: project_id
 *         schema: { type: integer }
 *         description: Optional project filter
 *     responses:
 *       200:
 *         description: Attendance summary for the given date
 *       400:
 *         description: Missing date parameter
 */
router.get("/summary", async (req, res) => {
  try {
    const { date, project_id } = req.query;
    if (!date) {
      return res.status(400).json({ error: "date query parameter is required (YYYY-MM-DD)" });
    }

    const { checked_in, checked_out, not_checked_in } =
      await buildAttendanceSummary(date, project_id || null);

    res.json({
      date,
      project_id: project_id || null,
      counts: {
        checked_in: checked_in.length,
        checked_out: checked_out.length,
        not_checked_in: not_checked_in.length,
      },
      checked_in,
      checked_out,
      not_checked_in,
    });
  } catch (error) {
    console.error("Get summary error:", error);
    res.status(500).json({ error: "Failed to fetch attendance summary" });
  }
});

/**
 * @swagger
 * /api/attendance/user/{user_id}/absent-count:
 *   get:
 *     summary: Get total absent count for a user
 *     tags: [Attendance]
 *     parameters:
 *       - in: path
 *         name: user_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Absent count details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user_id: { type: string }
 *                 absent_count: { type: integer }
 *                 limit: { type: integer }
 *                 can_mark_attendance: { type: boolean }
 */
router.get("/user/:user_id/absent-count", async (req, res) => {
  try {
    const { user_id } = req.params;
    const result = await pool.query(
      "SELECT COUNT(*) FROM attendance WHERE user_id = $1 AND status = 'absent'",
      [user_id]
    );
    const absentCount = parseInt(result.rows[0].count);
    res.json({
      user_id,
      absent_count: absentCount,
    });
  } catch (error) {
    console.error("Get absent count error:", error);
    res.status(500).json({ error: "Failed to fetch absent count" });
  }
});

/**
 * @swagger
 * /api/attendance/project/{project_id}:
 *   get:
 *     summary: Get all attendance records for a specific project
 *     tags: [Attendance]
 *     parameters:
 *       - in: path
 *         name: project_id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: List of attendance records for the project
 */
router.get("/project/:project_id", async (req, res) => {
  try {
    const { project_id } = req.params;
    const result = await pool.query(
      "SELECT * FROM attendance WHERE project_id = $1 ORDER BY date DESC, created_at DESC",
      [project_id]
    );
    res.json(await attachCreatedUpdatedBy(result.rows, "attendance", (r) => r.attendance_id));
  } catch (error) {
    console.error("Get project attendance error:", error);
    res.status(500).json({ error: "Failed to fetch project attendance records" });
  }
});

/**
 * @swagger
 * /api/attendance/user/{user_id}:
 *   get:
 *     summary: Get all attendance records for a specific user
 *     tags: [Attendance]
 *     parameters:
 *       - in: path
 *         name: user_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: List of attendance records for the user
 */
router.get("/user/:user_id", async (req, res) => {
  try {
    const { user_id } = req.params;
    const result = await pool.query(
      "SELECT * FROM attendance WHERE user_id = $1 ORDER BY date DESC, created_at DESC",
      [user_id]
    );
    res.json(await attachCreatedUpdatedBy(result.rows, "attendance", (r) => r.attendance_id));
  } catch (error) {
    console.error("Get user attendance error:", error);
    res.status(500).json({ error: "Failed to fetch user attendance records" });
  }
});

/**
 * @swagger
 * /api/attendance/blocked-users:
 *   get:
 *     summary: Get list of blocked users
 *     tags: [Attendance]
 *     responses:
 *       200:
 *         description: List of blocked users with absent count and block history
 */
router.get("/blocked-users", async (req, res) => {
  try {
    // Get users with is_blocked = true OR users with >=15 absents
    const blockedUsersResult = await pool.query(`
      SELECT 
        u.user_id,
        u.name,
        u.phone_number,
        u.email,
        u.role,
        u.is_blocked,
        (SELECT COUNT(*) FROM attendance a WHERE a.user_id = u.user_id AND a.status = 'absent') AS absent_count,
        COALESCE(
          (
            SELECT json_agg(json_build_object(
              'history_id', h.history_id,
              'action', h.action,
              'reason', h.reason,
              'performed_by', h.performed_by,
              'performed_by_name', h.performed_by_name,
              'created_at', h.created_at
            ) ORDER BY h.created_at DESC)
            FROM user_block_history h
            WHERE h.user_id = u.user_id
          ),
          '[]'::json
        ) AS block_history
      FROM auth_users u
      WHERE u.is_blocked = true
      ORDER BY u.name ASC
    `);

    res.json(blockedUsersResult.rows);
  } catch (error) {
    console.error("Get blocked users error:", error);
    res.status(500).json({ error: "Failed to fetch blocked users" });
  }
});

/**
 * @swagger
 * /api/attendance/block/{user_id}:
 *   patch:
 *     summary: Block a user
 *     tags: [Attendance]
 *     parameters:
 *       - in: path
 *         name: user_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason: { type: string }
 *               performed_by: { type: string, format: uuid }
 *               performed_by_name: { type: string }
 *     responses:
 *       200:
 *         description: User blocked successfully
 *       404:
 *         description: User not found
 */
router.patch("/block/:user_id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { user_id } = req.params;
    const { reason, performed_by, performed_by_name } = req.body;

    // Check if user exists
    const userResult = await client.query(
      "SELECT * FROM auth_users WHERE user_id = $1",
      [user_id]
    );

    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "User not found" });
    }

    // Update is_blocked to true
    await client.query(
      "UPDATE auth_users SET is_blocked = true, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1",
      [user_id]
    );

    // Insert into block history
    await client.query(
      `INSERT INTO user_block_history (user_id, action, reason, performed_by, performed_by_name)
       VALUES ($1, 'block', $2, $3, $4)`,
      [user_id, reason, performed_by, performed_by_name]
    );

    await client.query('COMMIT');

    // Get updated user data
    const updatedUserResult = await pool.query(`
      SELECT 
        u.user_id,
        u.name,
        u.phone_number,
        u.email,
        u.role,
        u.is_blocked,
        (SELECT COUNT(*) FROM attendance a WHERE a.user_id = u.user_id AND a.status = 'absent') AS absent_count
      FROM auth_users u
      WHERE u.user_id = $1
    `, [user_id]);

    res.json({
      message: "User blocked successfully",
      user: updatedUserResult.rows[0]
    });

    logActivity({
      action: "blocked_user",
      entity_type: "user",
      entity_id: user_id,
      entity_name: userResult.rows[0].name || userResult.rows[0].username,
      performed_by: performed_by || null,
      performed_by_name: performed_by_name || null,
      meta: { reason }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Block user error:", error);
    res.status(500).json({ error: "Failed to block user" });
  } finally {
    client.release();
  }
});

/**
 * @swagger
 * /api/attendance/unblock/{user_id}:
 *   patch:
 *     summary: Unblock a user
 *     tags: [Attendance]
 *     parameters:
 *       - in: path
 *         name: user_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason: { type: string }
 *               performed_by: { type: string, format: uuid }
 *               performed_by_name: { type: string }
 *     responses:
 *       200:
 *         description: User unblocked successfully
 *       404:
 *         description: User not found
 */
router.patch("/unblock/:user_id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { user_id } = req.params;
    const { reason, performed_by, performed_by_name } = req.body;

    // Check if user exists
    const userResult = await client.query(
      "SELECT * FROM auth_users WHERE user_id = $1",
      [user_id]
    );

    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "User not found" });
    }

    // Update is_blocked to false
    await client.query(
      "UPDATE auth_users SET is_blocked = false, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1",
      [user_id]
    );

    // Insert into block history
    await client.query(
      `INSERT INTO user_block_history (user_id, action, reason, performed_by, performed_by_name)
       VALUES ($1, 'unblock', $2, $3, $4)`,
      [user_id, reason, performed_by, performed_by_name]
    );

    await client.query('COMMIT');

    // Get updated user data
    const updatedUserResult = await pool.query(`
      SELECT 
        u.user_id,
        u.name,
        u.phone_number,
        u.email,
        u.role,
        u.is_blocked,
        (SELECT COUNT(*) FROM attendance a WHERE a.user_id = u.user_id AND a.status = 'absent') AS absent_count
      FROM auth_users u
      WHERE u.user_id = $1
    `, [user_id]);

    res.json({
      message: "User unblocked successfully",
      user: updatedUserResult.rows[0]
    });

    logActivity({
      action: "unblocked_user",
      entity_type: "user",
      entity_id: user_id,
      entity_name: userResult.rows[0].name || userResult.rows[0].username,
      performed_by: performed_by || null,
      performed_by_name: performed_by_name || null,
      meta: { reason }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Unblock user error:", error);
    res.status(500).json({ error: "Failed to unblock user" });
  } finally {
    client.release();
  }
});

/**
 * @swagger
 * /api/attendance/user/{user_id}/block-history:
 *   get:
 *     summary: Get block history for a specific user
 *     tags: [Attendance]
 *     parameters:
 *       - in: path
 *         name: user_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Block history for the user
 */
router.get("/user/:user_id/block-history", async (req, res) => {
  try {
    const { user_id } = req.params;
    const result = await pool.query(
      "SELECT * FROM user_block_history WHERE user_id = $1 ORDER BY created_at DESC",
      [user_id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Get block history error:", error);
    res.status(500).json({ error: "Failed to fetch block history" });
  }
});

/**
 * @swagger
 * /api/attendance/checkout/{id}:
 *   put:
 *     summary: Check out an attendance record
 *     tags: [Attendance]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               photo_selfie: { type: string }
 *               photo_site: { type: string }
 *               location: { type: string }
 *               latitude: { type: number }
 *               longitude: { type: number }
 *               user_id: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Checked out successfully
 */
router.put("/checkout/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { photo_selfie, photo_site, location, latitude, longitude, user_id } = req.body;

    const userResult = await pool.query(
      "SELECT check_out_time, role FROM auth_users WHERE user_id = $1",
      [user_id]
    );

    const attendanceResult = await pool.query(
      "SELECT remark FROM attendance WHERE attendance_id = $1",
      [id]
    );

    if (attendanceResult.rows.length === 0) {
      return res.status(404).json({ error: "Attendance record not found" });
    }

    let remark = attendanceResult.rows[0].remark || "";
    if (userResult.rows.length > 0 && userResult.rows[0].role === 'labour' && userResult.rows[0].check_out_time) {
      const designatedCheckOut = userResult.rows[0].check_out_time;
      const now = new Date();
      const [desigH, desigM, desigS] = designatedCheckOut.split(':').map(Number);
      const designatedDate = new Date(now);
      designatedDate.setHours(desigH, desigM, desigS || 0, 0);
      if (now < designatedDate) {
        const diffMins = Math.floor((designatedDate - now) / 60000);
        if (diffMins > 0) {
          const earlyRemark = `User checked out early by ${diffMins} minutes`;
          remark = remark ? `${remark}. ${earlyRemark}` : earlyRemark;
        }
      }
    }

    const result = await pool.query(
      `UPDATE attendance SET
        check_out_time = CURRENT_TIMESTAMP,
        check_out_photo_selfie = $1, check_out_photo_site = $2, check_out_location = $3,
        check_out_latitude = $4, check_out_longitude = $5,
        remark = $6, updated_at = CURRENT_TIMESTAMP
      WHERE attendance_id = $7 RETURNING *`,
      [photo_selfie, photo_site, location, latitude, longitude, remark, id]
    );

    res.json(result.rows[0]);

    logActivity({
      action: "checked_out",
      entity_type: "attendance",
      entity_id: id,
      entity_name: `Check-out for attendance ${id}`,
      performed_by: user_id || null,
      meta: { remark }
    });
  } catch (error) {
    console.error("Checkout error:", error);
    res.status(500).json({ error: "Failed to check out" });
  }
});

/**
 * @swagger
 * /api/attendance/{id}:
 *   get:
 *     summary: Get an attendance record by ID
 *     tags: [Attendance]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Attendance record
 *       404:
 *         description: Record not found
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM attendance WHERE attendance_id = $1", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Attendance record not found" });
    }
    res.json(await attachCreatedUpdatedBy(result.rows[0], "attendance", (r) => r.attendance_id));
  } catch (error) {
    console.error("Get attendance by ID error:", error);
    res.status(500).json({ error: "Failed to fetch attendance record" });
  }
});

/**
 * @swagger
 * /api/attendance/{id}/status:
 *   patch:
 *     summary: Update attendance status (present/absent/half_day)
 *     tags: [Attendance]
 *     parameters:
 *       - in: path
 *         name: id
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
 *               status: { type: string, enum: [present, absent, half_day] }
 *     responses:
 *       200:
 *         description: Status updated
 *       400:
 *         description: Invalid status value
 *       404:
 *         description: Record not found
 */
router.patch("/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['present', 'absent', 'half_day'].includes(status)) {
      return res.status(400).json({ error: "Status must be 'present', 'absent', or 'half_day'" });
    }

    const result = await pool.query(
      `UPDATE attendance SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE attendance_id = $2 RETURNING *`,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Attendance record not found" });
    }

    res.json(result.rows[0]);

    logActivity({
      action: "updated_status",
      entity_type: "attendance",
      entity_id: id,
      entity_name: `Status set to ${status} for attendance ${id}`,
      performed_by: req.body.updated_by || null,
      performed_by_name: req.body.updated_by_name || null,
      meta: { status }
    });
  } catch (error) {
    console.error("Update status error:", error);
    res.status(500).json({ error: "Failed to update status" });
  }
});

/**
 * @swagger
 * /api/attendance/{id}:
 *   put:
 *     summary: Update an attendance record
 *     tags: [Attendance]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Attendance'
 *     responses:
 *       200:
 *         description: Attendance record updated
 */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      photo_selfie, photo_site, location, latitude, longitude,
      user_name, phone_number, date, day, project_id, user_id, status,
    } = req.body;

    const result = await pool.query(
      `UPDATE attendance SET
        photo_selfie = $1, photo_site = $2, location = $3, latitude = $4, longitude = $5,
        user_name = $6, phone_number = $7, date = $8, day = $9, project_id = $10,
        user_id = $11, status = $12, updated_at = CURRENT_TIMESTAMP
      WHERE attendance_id = $13 RETURNING *`,
      [photo_selfie, photo_site, location, latitude, longitude,
       user_name, phone_number, date, day, project_id, user_id, status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Attendance record not found" });
    }

    res.json(result.rows[0]);

    logActivity({
      action: "updated",
      entity_type: "attendance",
      entity_id: id,
      entity_name: `Attendance for ${user_name} on ${date}`,
      performed_by: user_id || null,
      performed_by_name: user_name || null,
      meta: { project_id }
    });
  } catch (error) {
    console.error("Update attendance error:", error);
    res.status(500).json({ error: "Failed to update attendance record" });
  }
});

/**
 * @swagger
 * /api/attendance/{id}:
 *   delete:
 *     summary: Delete an attendance record
 *     tags: [Attendance]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Attendance record deleted
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("DELETE FROM attendance WHERE attendance_id = $1 RETURNING *", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Attendance record not found" });
    }
    res.json({ message: "Attendance record deleted successfully" });

    logActivity({
      action: "deleted",
      entity_type: "attendance",
      entity_id: id,
      entity_name: `Attendance record ${id}`,
      performed_by: req.query.user_id || null,
      performed_by_name: req.query.user_name || null,
      meta: {}
    });
  } catch (error) {
    console.error("Delete attendance error:", error);
    res.status(500).json({ error: "Failed to delete attendance record" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/attendance/:id/history — who created/updated/deleted this record, and when
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/attendance/{id}/history:
 *   get:
 *     summary: Get the create/update/delete history for an attendance record (who did what, and when)
 *     tags: [Attendance]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *       - in: query
 *         name: offset
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Activity history for this attendance record
 */
router.get("/:id/history", async (req, res) => {
  try {
    const data = await getEntityHistory("attendance", req.params.id, {
      limit: req.query.limit, offset: req.query.offset,
    });
    res.json(data);
  } catch (error) {
    console.error("Error fetching attendance history:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
