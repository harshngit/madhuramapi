const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { pool } = require("../db");
const { logActivity, getEntityHistory } = require("./dashboard"); // adjust path if needed


const router = express.Router();

// Ensure uploads directory exists, if not create it
const uploadDir = path.join(__dirname, "../../uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure Multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir); // Save files to 'uploads' directory
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname));
  },
});

const PROJECT_UPLOAD_MAX_MB = Number(process.env.PROJECT_UPLOAD_MAX_MB || 100);
const PROJECT_UPLOAD_MAX_BYTES = Math.max(1, PROJECT_UPLOAD_MAX_MB) * 1024 * 1024;

const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value));

const upload = multer({
  storage: storage,
  limits: { fileSize: PROJECT_UPLOAD_MAX_BYTES }
});

const uploadFields = upload.fields([
  { name: "work_order_file", maxCount: 1 },
  { name: "mas_file", maxCount: 1 },
]);

// Wrapper middleware to handle Multer errors
const uploadMiddleware = (req, res, next) => {
  uploadFields(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res
          .status(400)
          .json({ error: `File size too large. Max limit is ${Math.max(1, PROJECT_UPLOAD_MAX_MB)}MB.` });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    } else if (err) {
      return res.status(500).json({ error: `Server upload error: ${err.message}` });
    }
    next();
  });
};

/**
 * @swagger
 * components:
 *   schemas:
 *     Project:
 *       type: object
 *       properties:
 *         project_id:
 *           type: integer
 *         project_name:
 *           type: string
 *         project_startdate:
 *           type: string
 *           format: date
 *         client_name:
 *           type: string
 *         location:
 *           type: string
 *         floor:
 *           type: string
 *         estimate_value:
 *           type: string
 *         wo_number:
 *           type: string
 *         work_order_file:
 *           type: string
 *         pr_po_tracking:
 *           type: array
 *           items:
 *             type: string
 *         samples:
 *           type: array
 *           items:
 *             type: string
 *         mas_file:
 *           type: string
 *         ml_management:
 *           type: array
 *           items:
 *             type: string
 *         flats:
 *           type: integer
 *         refuge_flat:
 *           type: integer
 *         toilets:
 *           type: integer
 *         location_data:
 *           type: object
 *           properties:
 *             latitude:
 *               type: number
 *               format: double
 *             longitude:
 *               type: number
 *               format: double
 *             radius:
 *               type: number
 *               format: double
 *             location_name:
 *               type: string
 *         user_id:
 *           type: string
 *           format: uuid
 *         created_at:
 *           type: string
 *           format: date-time
 */

/**
 * @swagger
 * tags:
 *   name: Projects
 *   description: Project Management API
 */

/**
 * @swagger
 * /api/projects:
 *   post:
 *     summary: Create a new project
 *     tags: [Projects]
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - project_name
 *             properties:
 *               project_name:
 *                 type: string
 *               project_startdate:
 *                 type: string
 *                 format: date
 *               client_name:
 *                 type: string
 *               location:
 *                 type: string
 *               floor:
 *                 type: string
 *               estimate_value:
 *                 type: string
 *               wo_number:
 *                 type: string
 *               work_order_file:
 *                 type: string
 *                 format: binary
 *               pr_po_tracking:
 *                 type: array
 *                 items:
 *                   type: string
 *               samples:
 *                 type: array
 *                 items:
 *                   type: string
 *               mas_file:
 *                 type: string
 *                 format: binary
 *               ml_management:
 *                 type: array
 *                 items:
 *                   type: string
 *               flats:
 *                 type: integer
 *               refuge_flat:
 *                 type: integer
 *               toilets:
 *                 type: integer
 *               user_id:
 *                 type: string
 *                 format: uuid
 *               location_latitude:
 *                 type: number
 *                 format: double
 *               location_longitude:
 *                 type: number
 *                 format: double
 *               location_radius:
 *                 type: number
 *                 format: double
 *               location_name:
 *                 type: string
 *     responses:
 *       201:
 *         description: Project created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Project'
 *       500:
 *         description: Server error
 */
router.post("/", uploadMiddleware, async (req, res) => {
  try {
    const {
      project_name,
      project_startdate,
      client_name,
      location,
      floor,
      estimate_value,
      wo_number,
      pr_po_tracking,
      samples,
      ml_management,
      flats,
      refuge_flat,
      toilets,
      user_id,
      location_latitude,
      location_longitude,
      location_radius,
      location_name,
    } = req.body;

    const userIdValue = user_id === undefined || user_id === null || String(user_id).trim() === "" ? null : String(user_id).trim();

    if (userIdValue !== null) {
      if (!isUuid(userIdValue)) {
        return res.status(400).json({ error: "Invalid user_id. Must be a UUID." });
      }
      const userExists = await pool.query("SELECT 1 FROM auth_users WHERE user_id = $1", [userIdValue]);
      if (userExists.rowCount === 0) {
        return res.status(400).json({ error: "Invalid user_id. User does not exist." });
      }
    }

    // Get the file names for uploaded files
    const work_order_file = req.files && req.files["work_order_file"] ? req.files["work_order_file"][0].filename : null;
    const mas_file = req.files && req.files["mas_file"] ? req.files["mas_file"][0].filename : null;

    // Parse JSON/Array fields if they come as strings
    let prPoTracking = pr_po_tracking;
    if (typeof pr_po_tracking === 'string') {
      try { prPoTracking = JSON.parse(pr_po_tracking); } catch (e) { prPoTracking = [pr_po_tracking]; }
    }

    let samplesArr = samples;
    if (typeof samples === 'string') {
      try { samplesArr = JSON.parse(samples); } catch (e) { samplesArr = [samples]; }
    }

    let mlManagementArr = ml_management;
    if (typeof ml_management === 'string') {
      try { mlManagementArr = JSON.parse(ml_management); } catch (e) { mlManagementArr = [ml_management]; }
    }

    const locationData = {
      latitude: location_latitude ? parseFloat(location_latitude) : null,
      longitude: location_longitude ? parseFloat(location_longitude) : null,
      radius: location_radius ? parseFloat(location_radius) : null,
      location_name: location_name || null,
    };

    // Insert into the database
    const result = await pool.query(
      `INSERT INTO projects (
        project_name, project_startdate, client_name, location, floor, estimate_value, wo_number,
        work_order_file, pr_po_tracking, samples, mas_file, ml_management, flats, refuge_flat, toilets, user_id, location_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
      [
        project_name,
        project_startdate,
        client_name,
        location,
        floor,
        estimate_value,
        wo_number,
        work_order_file,
        prPoTracking || [],
        samplesArr || [],
        mas_file,
        mlManagementArr || [],
        flats || null,
        refuge_flat || null,
        toilets || null,
        userIdValue,
        JSON.stringify(locationData),
      ]
    );

    // Send response back
    res.status(201).json(result.rows[0]);
    logActivity({
  action: "created",
  entity_type: "project",
  entity_id: result.rows[0].project_id,
  entity_name: result.rows[0].project_name,
  performed_by: result.rows[0].user_id || null,
  performed_by_name: req.body.created_by_name || null,
  meta: {},
});
  } catch (error) {
    console.error("Create project error:", error);
    if (error && error.code === "23503" && error.constraint === "projects_user_id_fkey") {
      return res.status(400).json({ error: "Invalid user_id. User does not exist." });
    }
    if (error && error.code === "22P02") {
      return res.status(400).json({ error: "Invalid user_id. Must be a UUID." });
    }
    res.status(500).json({ error: "Failed to create project" });
  }
});

/**
 * @swagger
 * /api/projects:
 *   get:
 *     summary: Get all projects
 *     tags: [Projects]
 *     responses:
 *       200:
 *         description: List of projects
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Project'
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM projects ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (error) {
    console.error("Get projects error:", error);
    res.status(500).json({ error: "Failed to fetch projects" });
  }
});

/**
 * @swagger
 * /api/projects/{id}:
 *   get:
 *     summary: Get a project by ID
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Project ID
 *     responses:
 *       200:
 *         description: Project details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Project'
 *       404:
 *         description: Project not found
 *       500:
 *         description: Server error
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM projects WHERE project_id = $1", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Project not found" });
    }

    res.json(result.rows[0]);

    // Log Activity
    logActivity({
      action: "updated",
      entity_type: "project",
      entity_id: id,
      entity_name: result.rows[0].project_name,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: id,
      meta: { updates: req.body }
    });
  } catch (error) {
    console.error("Get project error:", error);
    res.status(500).json({ error: "Failed to fetch project" });
  }
});

/**
 * @swagger
 * /api/projects/{id}:
 *   put:
 *     summary: Update a project
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Project ID
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               project_name:
 *                 type: string
 *               project_startdate:
 *                 type: string
 *                 format: date
 *               client_name:
 *                 type: string
 *               location:
 *                 type: string
 *               floor:
 *                 type: string
 *               estimate_value:
 *                 type: string
 *               wo_number:
 *                 type: string
 *               work_order_file:
 *                 type: string
 *                 format: binary
 *               pr_po_tracking:
 *                 type: array
 *                 items:
 *                   type: string
 *               samples:
 *                 type: array
 *                 items:
 *                   type: string
 *               mas_file:
 *                 type: string
 *                 format: binary
 *               ml_management:
 *                 type: array
 *                 items:
 *                   type: string
 *               flats:
 *                 type: integer
 *               refuge_flat:
 *                 type: integer
 *               toilets:
 *                 type: integer
 *               location_latitude:
 *                 type: number
 *                 format: double
 *               location_longitude:
 *                 type: number
 *                 format: double
 *               location_radius:
 *                 type: number
 *                 format: double
 *               location_name:
 *                 type: string
 *     responses:
 *       200:
 *         description: Project updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Project'
 *       404:
 *         description: Project not found
 *       500:
 *         description: Server error
 */
router.put("/:id", uploadMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      project_name,
      project_startdate,
      client_name,
      location,
      floor,
      estimate_value,
      wo_number,
      pr_po_tracking,
      samples,
      ml_management,
      flats,
      refuge_flat,
      toilets,
      location_latitude,
      location_longitude,
      location_radius,
      location_name,
    } = req.body;

    const work_order_file = req.files && req.files["work_order_file"] ? req.files["work_order_file"][0].filename : null;
    const mas_file = req.files && req.files["mas_file"] ? req.files["mas_file"][0].filename : null;

    let prPoTracking = pr_po_tracking;
    if (typeof pr_po_tracking === 'string') {
      try { prPoTracking = JSON.parse(pr_po_tracking); } catch (e) { prPoTracking = [pr_po_tracking]; }
    }

    let samplesArr = samples;
    if (typeof samples === 'string') {
      try { samplesArr = JSON.parse(samples); } catch (e) { samplesArr = [samples]; }
    }

    let mlManagementArr = ml_management;
    if (typeof ml_management === 'string') {
      try { mlManagementArr = JSON.parse(ml_management); } catch (e) { mlManagementArr = [ml_management]; }
    }

    const locationData = {
      latitude: location_latitude ? parseFloat(location_latitude) : null,
      longitude: location_longitude ? parseFloat(location_longitude) : null,
      radius: location_radius ? parseFloat(location_radius) : null,
      location_name: location_name || null,
    };

    const result = await pool.query(
      `UPDATE projects SET
        project_name = $1,
        project_startdate = $2,
        client_name = $3,
        location = $4,
        floor = $5,
        estimate_value = $6,
        wo_number = $7,
        pr_po_tracking = $8,
        samples = $9,
        ml_management = $10,
        work_order_file = COALESCE($11, work_order_file),
        mas_file = COALESCE($12, mas_file),
        flats = $13,
        refuge_flat = $14,
        toilets = $15,
        location_data = $16,
        updated_at = CURRENT_TIMESTAMP
      WHERE project_id = $17
      RETURNING *`,
      [
        project_name,
        project_startdate,
        client_name,
        location,
        floor,
        estimate_value,
        wo_number,
        prPoTracking,
        samplesArr,
        mlManagementArr,
        work_order_file,
        mas_file,
        flats || null,
        refuge_flat || null,
        toilets || null,
        JSON.stringify(locationData),
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Project not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Update project error:", error);
    res.status(500).json({ error: "Failed to update project" });
  }
});

/**
 * @swagger
 * /api/projects/{id}:
 *   delete:
 *     summary: Delete a project
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Project ID
 *     responses:
 *       200:
 *         description: Project deleted successfully
 *       404:
 *         description: Project not found
 *       500:
 *         description: Server error
 */
router.delete("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "id must be a valid integer" });
    }

    const result = await pool.query("DELETE FROM projects WHERE project_id = $1 RETURNING *", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Project not found" });
    }

    res.json({ message: "Project deleted successfully" });
    // After project DELETE:
logActivity({
  action: "deleted",
  entity_type: "project",
  entity_id: id,
  entity_name: result.rows[0].project_name,
  performed_by: null,
  performed_by_name: null,
});
  } catch (error) {
    console.error("Delete project error:", error);

    res.status(500).json({ error: "Failed to delete project" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/projects/:id/history — who created/updated/deleted this project, and when
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/projects/{id}/history:
 *   get:
 *     summary: Get the create/update/delete history for a project (who did what, and when)
 *     tags: [Projects]
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
 *         description: Activity history for this project
 */
router.get("/:id/history", async (req, res) => {
  try {
    const data = await getEntityHistory("project", req.params.id, {
      limit: req.query.limit, offset: req.query.offset,
    });
    res.json(data);
  } catch (error) {
    console.error("Error fetching project history:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * @swagger
 * /api/projects/user/{userId}:
 *   get:
 *     summary: Get all projects for a specific user
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: userId
 *         schema:
 *           type: string
 *           format: uuid
 *         required: true
 *         description: User ID (UUID)
 *     responses:
 *       200:
 *         description: List of projects for the user
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Project'
 *       500:
 *         description: Server error
 */
router.get("/user/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      "SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at DESC",
      [userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Get user projects error:", error);
    res.status(500).json({ error: "Failed to fetch user projects" });
  }
});

module.exports = router;
