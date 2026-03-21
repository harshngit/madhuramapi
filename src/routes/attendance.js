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
    } = req.body;

    const result = await pool.query(
      `INSERT INTO attendance (
        photo_selfie, photo_site, location, latitude, longitude,
        user_name, phone_number, date, day, project_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
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
      ]
    );

    res.status(201).json(result.rows[0]);

    logActivity({
      action: "created",
      entity_type: "attendance",
      entity_id: result.rows[0].attendance_id,
      entity_name: `Attendance for ${user_name} on ${date}`,
      performed_by: req.body.user_id || null,
      performed_by_name: user_name || null,
      meta: { project_id }
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
    } = req.body;

    const result = await pool.query(
      `UPDATE attendance SET
        photo_selfie = $1, photo_site = $2, location = $3, latitude = $4, longitude = $5,
        user_name = $6, phone_number = $7, date = $8, day = $9, project_id = $10,
        updated_at = CURRENT_TIMESTAMP
      WHERE attendance_id = $11 RETURNING *`,
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
      performed_by: req.body.user_id || null,
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

module.exports = router;
