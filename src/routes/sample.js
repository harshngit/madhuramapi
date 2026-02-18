const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const uploadDir = path.join(__dirname, "../../uploads/sample");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

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
 *     Sample:
 *       type: object
 *       properties:
 *         sample_id:
 *           type: integer
 *         project_id:
 *           type: integer
 *         building_name:
 *           type: string
 *         site_name:
 *           type: string
 *         location:
 *           type: object
 *           properties:
 *             address_line1:
 *               type: string
 *             address_line2:
 *               type: string
 *             city:
 *               type: string
 *             state:
 *               type: string
 *             country:
 *               type: string
 *         work_done:
 *           type: string
 *         item_description:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               sr_no:
 *                 type: integer
 *               description:
 *                 type: string
 *               quantity:
 *                 type: number
 *               value:
 *                 type: number
 *               add_fields:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     key:
 *                       type: string
 *                     value:
 *                       type: string
 *         add_fields:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               key:
 *                 type: string
 *               value:
 *                 type: string
 *         sample_file:
 *           type: string
 *         created_at:
 *           type: string
 *           format: date-time
 */

/**
 * @swagger
 * tags:
 *   name: Sample
 *   description: Sample management
 */

/**
 * @swagger
 * /api/sample/upload:
 *   post:
 *     summary: Upload multiple files for Sample
 *     tags: [Sample]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *     responses:
 *       200:
 *         description: Files uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 filePaths:
 *                   type: array
 *                   items:
 *                     type: string
 *       400:
 *         description: No files uploaded
 */
router.post("/upload", upload.array("file"), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No files uploaded" });
  }
  const filePaths = req.files.map((f) => `/uploads/sample/${f.filename}`);
  res.json({ filePaths });
});

/**
 * @swagger
 * /api/sample/create-sample:
 *   post:
 *     summary: Create a new sample
 *     tags: [Sample]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               project_id:
 *                 type: integer
 *               building_name:
 *                 type: string
 *               site_name:
 *                 type: string
 *               location:
 *                 type: object
 *                 properties:
 *                   address_line1:
 *                     type: string
 *                   address_line2:
 *                     type: string
 *                   city:
 *                     type: string
 *                   state:
 *                     type: string
 *                   country:
 *                     type: string
 *               work_done:
 *                 type: string
 *               item_description:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     sr_no:
 *                       type: integer
 *                     description:
 *                       type: string
 *                     quantity:
 *                       type: number
 *                     value:
 *                       type: number
 *                     add_fields:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           key:
 *                             type: string
 *                           value:
 *                             type: string
 *               add_fields:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     key:
 *                       type: string
 *                     value:
 *                       type: string
 *     responses:
 *       201:
 *         description: Sample created successfully
 *       400:
 *         description: Invalid project_id
 *       500:
 *         description: Server error
 */
router.post("/create-sample", async (req, res) => {
  try {
    const {
      project_id,
      building_name,
      site_name,
      location,
      work_done,
      item_description,
      add_fields,
    } = req.body;

    const query = `
      INSERT INTO samples (
        project_id,
        building_name,
        site_name,
        location,
        work_done,
        item_description,
        add_fields
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `;

    const values = [
      project_id,
      building_name,
      site_name,
      location ? JSON.stringify(location) : null,
      work_done,
      item_description ? JSON.stringify(item_description) : JSON.stringify([]),
      add_fields ? JSON.stringify(add_fields) : JSON.stringify([]),
    ];

    const result = await pool.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error creating sample:", error);
    if (error.code === "23503") {
      return res.status(400).json({ error: "Invalid project_id: Project does not exist" });
    }
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * @swagger
 * /api/sample:
 *   get:
 *     summary: Get all samples
 *     tags: [Sample]
 *     responses:
 *       200:
 *         description: List of all samples
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Sample'
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM samples ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching samples:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * @swagger
 * /api/sample/{id}:
 *   get:
 *     summary: Get a sample by ID
 *     tags: [Sample]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Sample details
 *       404:
 *         description: Sample not found
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM samples WHERE sample_id = $1", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Sample not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching sample:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * @swagger
 * /api/sample/project/{projectId}:
 *   get:
 *     summary: Get samples by Project ID
 *     tags: [Sample]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of samples for the project
 */
router.get("/project/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;
    const result = await pool.query(
      "SELECT * FROM samples WHERE project_id = $1 ORDER BY created_at DESC",
      [projectId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching project samples:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * @swagger
 * /api/sample/{id}:
 *   put:
 *     summary: Update a sample
 *     tags: [Sample]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               building_name:
 *                 type: string
 *               site_name:
 *                 type: string
 *               location:
 *                 type: object
 *               work_done:
 *                 type: string
 *               item_description:
 *                 type: array
 *               add_fields:
 *                 type: array
 *               sample_file:
 *                 type: string
 *     responses:
 *       200:
 *         description: Sample updated successfully
 *       404:
 *         description: Sample not found
 */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      building_name,
      site_name,
      location,
      work_done,
      item_description,
      add_fields,
      sample_file,
    } = req.body;

    const query = `
      UPDATE samples SET
        building_name = COALESCE($1, building_name),
        site_name = COALESCE($2, site_name),
        location = COALESCE($3, location),
        work_done = COALESCE($4, work_done),
        item_description = COALESCE($5, item_description),
        add_fields = COALESCE($6, add_fields),
        sample_file = COALESCE($7, sample_file),
        updated_at = CURRENT_TIMESTAMP
      WHERE sample_id = $8
      RETURNING *;
    `;

    const values = [
      building_name,
      site_name,
      location ? JSON.stringify(location) : null,
      work_done,
      item_description ? JSON.stringify(item_description) : null,
      add_fields ? JSON.stringify(add_fields) : null,
      sample_file || null,
      id,
    ];

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Sample not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error updating sample:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * @swagger
 * /api/sample/{id}:
 *   delete:
 *     summary: Delete a sample
 *     tags: [Sample]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Sample deleted successfully
 *       404:
 *         description: Sample not found
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("DELETE FROM samples WHERE sample_id = $1 RETURNING *", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Sample not found" });
    }

    res.json({ message: "Sample deleted successfully" });
  } catch (error) {
    console.error("Error deleting sample:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
