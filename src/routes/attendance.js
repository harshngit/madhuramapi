const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { logActivity } = require("./dashboard");

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
 *           enum: [pending, present, absent]
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
 *   description: Attendance management API
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
 *     summary: Create a new attendance record
 *     tags: [Attendance]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               photo_selfie:
 *                 type: string
 *               photo_site:
 *                 type: string
 *               location:
 *                 type: string
 *               latitude:
 *                 type: number
 *               longitude:
 *                 type: number
 *               user_name:
 *                 type: string
 *               phone_number:
 *                 type: string
 *               date:
 *                 type: string
 *                 format: date
 *               day:
 *                 type: string
 *               project_id:
 *                 type: integer
 *               user_id:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       201:
 *         description: Attendance record created
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

    // Fetch user's designated check-in time for lateness calculation
    const userResult = await pool.query(
      "SELECT check_in_time, role FROM auth_users WHERE user_id = $1",
      [user_id]
    );

    let remark = null;
    if (userResult.rows.length > 0 && userResult.rows[0].role === 'labour' && userResult.rows[0].check_in_time) {
      const designatedCheckIn = userResult.rows[0].check_in_time;
      const now = new Date();
      
      // Parse HH:MM:SS
      const [desigH, desigM, desigS] = designatedCheckIn.split(':').map(Number);
      const designatedDate = new Date(now);
      designatedDate.setHours(desigH, desigM, desigS || 0, 0);

      if (now > designatedDate) {
        const diffMs = now - designatedDate;
        const diffMins = Math.floor(diffMs / 60000);
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
      [
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
        remark,
      ]
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
    res.status(500).json({ error: "Failed to create attendance record" });
  }
});

/**
 * @swagger
 * /api/attendance:
 *   get:
 *     summary: Get all attendance records
 *     tags: [Attendance]
 *     responses:
 *       200:
 *         description: List of attendance records
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Attendance'
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM attendance ORDER BY date DESC, created_at DESC");
    res.json(result.rows);
  } catch (error) {
    console.error("Get attendance error:", error);
    res.status(500).json({ error: "Failed to fetch attendance records" });
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
 *         schema:
 *           type: integer
 *         description: Project ID
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
    res.json(result.rows);
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
 *         schema:
 *           type: string
 *           format: uuid
 *         description: User ID
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
    res.json(result.rows);
  } catch (error) {
    console.error("Get user attendance error:", error);
    res.status(500).json({ error: "Failed to fetch user attendance records" });
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
 *         schema:
 *           type: integer
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
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Get attendance by ID error:", error);
    res.status(500).json({ error: "Failed to fetch attendance record" });
  }
});

/**
 * @swagger
 * /api/attendance/{id}/status:
 *   patch:
 *     summary: Update attendance status (present/absent)
 *     tags: [Attendance]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Attendance ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [present, absent]
 *     responses:
 *       200:
 *         description: Status updated successfully
 *       400:
 *         description: Invalid status
 *       404:
 *         description: Record not found
 *       500:
 *         description: Server error
 */
router.patch("/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['present', 'absent'].includes(status)) {
      return res.status(400).json({ error: "Status must be 'present' or 'absent'" });
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
 *         schema:
 *           type: integer
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
      status,
    } = req.body;

    const result = await pool.query(
      `UPDATE attendance SET
        photo_selfie = $1, photo_site = $2, location = $3, latitude = $4, longitude = $5,
        user_name = $6, phone_number = $7, date = $8, day = $9, project_id = $10,
        user_id = $11, status = $12, updated_at = CURRENT_TIMESTAMP
      WHERE attendance_id = $13 RETURNING *`,
      [
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
        status,
        id,
      ]
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
 *         schema:
 *           type: integer
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
 *         schema:
 *           type: integer
 *         description: Attendance ID
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
    const {
      photo_selfie,
      photo_site,
      location,
      latitude,
      longitude,
      user_id
    } = req.body;

    // Fetch user's designated check-out time and current attendance record
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
      
      // Parse HH:MM:SS
      const [desigH, desigM, desigS] = designatedCheckOut.split(':').map(Number);
      const designatedDate = new Date(now);
      designatedDate.setHours(desigH, desigM, desigS || 0, 0);

      if (now < designatedDate) {
        const diffMs = designatedDate - now;
        const diffMins = Math.floor(diffMs / 60000);
        if (diffMins > 0) {
          const earlyRemark = `User checked out early by ${diffMins} minutes`;
          remark = remark ? `${remark}. ${earlyRemark}` : earlyRemark;
        }
      }
    }

    const result = await pool.query(
      `UPDATE attendance SET
        check_out_time = CURRENT_TIMESTAMP,
        check_out_photo_selfie = $1,
        check_out_photo_site = $2,
        check_out_location = $3,
        check_out_latitude = $4,
        check_out_longitude = $5,
        remark = $6,
        updated_at = CURRENT_TIMESTAMP
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

module.exports = router;
