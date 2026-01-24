const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { pool } = require("../db");

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

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
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
        return res.status(400).json({ error: "File size too large. Max limit is 5MB." });
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
 *         product_duration:
 *           type: string
 *           format: date
 *         client_name:
 *           type: string
 *         work_order_file:
 *           type: string
 *         work_order_information:
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
 *               product_duration:
 *                 type: string
 *                 format: date
 *               client_name:
 *                 type: string
 *               work_order_file:
 *                 type: string
 *                 format: binary
 *               work_order_information:
 *                 type: string
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
      product_duration,
      client_name,
      work_order_information,
      pr_po_tracking,
      samples,
      ml_management,
    } = req.body;

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

    // Insert into the database
    const result = await pool.query(
      `INSERT INTO projects (
        project_name, product_duration, client_name, work_order_file, 
        work_order_information, pr_po_tracking, samples, mas_file, ml_management
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        project_name,
        product_duration,
        client_name,
        work_order_file,
        work_order_information,
        prPoTracking || [],
        samplesArr || [],
        mas_file,
        mlManagementArr || [],
      ]
    );

    // Send response back
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Create project error:", error);
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
 *               product_duration:
 *                 type: string
 *                 format: date
 *               client_name:
 *                 type: string
 *               work_order_file:
 *                 type: string
 *                 format: binary
 *               work_order_information:
 *                 type: string
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
      product_duration,
      client_name,
      work_order_information,
      pr_po_tracking,
      samples,
      ml_management,
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

    const result = await pool.query(
      `UPDATE projects SET
        project_name = $1,
        product_duration = $2,
        client_name = $3,
        work_order_information = $4,
        pr_po_tracking = $5,
        samples = $6,
        ml_management = $7,
        work_order_file = COALESCE($8, work_order_file),
        mas_file = COALESCE($9, mas_file),
        updated_at = CURRENT_TIMESTAMP
      WHERE project_id = $10
      RETURNING *`,
      [
        project_name,
        product_duration,
        client_name,
        work_order_information,
        prPoTracking,
        samplesArr,
        mlManagementArr,
        work_order_file,
        mas_file,
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
    const { id } = req.params;
    const result = await pool.query("DELETE FROM projects WHERE project_id = $1 RETURNING *", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Project not found" });
    }

    res.json({ message: "Project deleted successfully" });
  } catch (error) {
    console.error("Delete project error:", error);
    res.status(500).json({ error: "Failed to delete project" });
  }
});

module.exports = router;
