const express = require("express");
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const router = express.Router();

// Ensure upload directory exists
const uploadDir = path.join(__dirname, "../../uploads/mir");
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
 *     MIR:
 *       type: object
 *       properties:
 *         mir_id:
 *           type: integer
 *         project_name:
 *           type: string
 *         project_code:
 *           type: string
 *         client_name:
 *           type: string
 *         pmc:
 *           type: string
 *         contractor:
 *           type: string
 *         vendor_code:
 *           type: string
 *         mir_refrence_no:
 *           type: string
 *         material_code:
 *           type: string
 *         inspection_date_time:
 *           type: string
 *           format: date-time
 *         client_submission_date:
 *           type: string
 *           format: date
 *         refrence_docs_attached:
 *           type: string
 *           description: File path returned from /api/mir/upload
 *         mir_submited:
 *           type: boolean
 *         dynamic_field:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               key:
 *                 type: string
 *               value:
 *                 type: string
 *           example: [{"key": "Field1", "value": "Value1"}, {"key": "Field2", "value": "Value2"}]
 *         project_id:
 *           type: integer
 *         created_at:
 *           type: string
 *           format: date-time
 */

/**
 * @swagger
 * /api/mir/upload:
 *   post:
 *     summary: Upload a file for MIR
 *     tags: [MIR]
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
 *                   description: The path to the uploaded file
 */
router.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  // Return the relative path to be stored in the database
  const filePath = `/uploads/mir/${req.file.filename}`;
  res.json({ filePath });
});

/**
 * @swagger
 * /api/mir:
 *   post:
 *     summary: Create a new MIR (Material Inspection Request)
 *     tags: [MIR]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               project_name:
 *                 type: string
 *               project_code:
 *                 type: string
 *               client_name:
 *                 type: string
 *               pmc:
 *                 type: string
 *               contractor:
 *                 type: string
 *               vendor_code:
 *                 type: string
 *               mir_refrence_no:
 *                 type: string
 *               material_code:
 *                 type: string
 *               inspection_date_time:
 *                 type: string
 *                 format: date-time
 *               client_submission_date:
 *                 type: string
 *                 format: date
 *               refrence_docs_attached:
 *                 type: string
 *               mir_submited:
 *                 type: boolean
 *               dynamic_field:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     key:
 *                       type: string
 *                     value:
 *                       type: string
 *               project_id:
 *                 type: integer
 *     responses:
 *       201:
 *         description: MIR created successfully
 *       400:
 *         description: Bad request (invalid project_id or data)
 *       500:
 *         description: Server error
 */
router.post("/", async (req, res) => {
  try {
    const {
      project_name,
      project_code,
      client_name,
      pmc,
      contractor,
      vendor_code,
      mir_refrence_no,
      material_code,
      inspection_date_time,
      client_submission_date,
      refrence_docs_attached,
      mir_submited,
      dynamic_field,
      project_id,
    } = req.body;

    const query = `
      INSERT INTO mirs (
        project_name, project_code, client_name, pmc, contractor, vendor_code,
        mir_refrence_no, material_code, inspection_date_time, client_submission_date,
        refrence_docs_attached, mir_submited, dynamic_field, project_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *;
    `;

    const values = [
      project_name,
      project_code,
      client_name,
      pmc,
      contractor,
      vendor_code,
      mir_refrence_no,
      material_code,
      inspection_date_time,
      client_submission_date,
      refrence_docs_attached,
      mir_submited,
      JSON.stringify(dynamic_field || []),
      project_id,
    ];

    const result = await pool.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error creating MIR:", error);
    if (error.code === '23503') {
      return res.status(400).json({ error: "Invalid project_id: Project does not exist" });
    }
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * @swagger
 * /api/mir:
 *   get:
 *     summary: Get all MIRs
 *     tags: [MIR]
 *     responses:
 *       200:
 *         description: List of all MIRs
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/MIR'
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM mirs ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching MIRs:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * @swagger
 * /api/mir/{id}:
 *   get:
 *     summary: Get a MIR by ID
 *     tags: [MIR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: MIR details
 *       404:
 *         description: MIR not found
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM mirs WHERE mir_id = $1", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "MIR not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching MIR:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * @swagger
 * /api/mir/project/{projectId}:
 *   get:
 *     summary: Get MIRs by Project ID
 *     tags: [MIR]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of MIRs for the project
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/MIR'
 */
router.get("/project/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;
    const result = await pool.query("SELECT * FROM mirs WHERE project_id = $1 ORDER BY created_at DESC", [projectId]);
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching project MIRs:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * @swagger
 * /api/mir/{id}:
 *   put:
 *     summary: Update a MIR
 *     tags: [MIR]
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
 *               project_name:
 *                 type: string
 *               project_code:
 *                 type: string
 *               client_name:
 *                 type: string
 *               pmc:
 *                 type: string
 *               contractor:
 *                 type: string
 *               vendor_code:
 *                 type: string
 *               mir_refrence_no:
 *                 type: string
 *               material_code:
 *                 type: string
 *               inspection_date_time:
 *                 type: string
 *                 format: date-time
 *               client_submission_date:
 *                 type: string
 *                 format: date
 *               refrence_docs_attached:
 *                 type: string
 *               mir_submited:
 *                 type: boolean
 *               dynamic_field:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     key:
 *                       type: string
 *                     value:
 *                       type: string
 *               project_id:
 *                 type: integer
 *     responses:
 *       200:
 *         description: MIR updated successfully
 */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      project_name,
      project_code,
      client_name,
      pmc,
      contractor,
      vendor_code,
      mir_refrence_no,
      material_code,
      inspection_date_time,
      client_submission_date,
      refrence_docs_attached,
      mir_submited,
      dynamic_field,
      project_id,
    } = req.body;

    let updateFields = [];
    let values = [];
    let counter = 1;

    if (project_name !== undefined) { updateFields.push(`project_name = $${counter++}`); values.push(project_name); }
    if (project_code !== undefined) { updateFields.push(`project_code = $${counter++}`); values.push(project_code); }
    if (client_name !== undefined) { updateFields.push(`client_name = $${counter++}`); values.push(client_name); }
    if (pmc !== undefined) { updateFields.push(`pmc = $${counter++}`); values.push(pmc); }
    if (contractor !== undefined) { updateFields.push(`contractor = $${counter++}`); values.push(contractor); }
    if (vendor_code !== undefined) { updateFields.push(`vendor_code = $${counter++}`); values.push(vendor_code); }
    if (mir_refrence_no !== undefined) { updateFields.push(`mir_refrence_no = $${counter++}`); values.push(mir_refrence_no); }
    if (material_code !== undefined) { updateFields.push(`material_code = $${counter++}`); values.push(material_code); }
    if (inspection_date_time !== undefined) { updateFields.push(`inspection_date_time = $${counter++}`); values.push(inspection_date_time); }
    if (client_submission_date !== undefined) { updateFields.push(`client_submission_date = $${counter++}`); values.push(client_submission_date); }
    if (refrence_docs_attached !== undefined) { updateFields.push(`refrence_docs_attached = $${counter++}`); values.push(refrence_docs_attached); }
    if (mir_submited !== undefined) { updateFields.push(`mir_submited = $${counter++}`); values.push(mir_submited); }
    if (dynamic_field !== undefined) { updateFields.push(`dynamic_field = $${counter++}`); values.push(JSON.stringify(dynamic_field)); }
    if (project_id !== undefined) { updateFields.push(`project_id = $${counter++}`); values.push(project_id); }

    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);

    if (updateFields.length === 1) { // Only updated_at
      return res.status(400).json({ error: "No fields to update" });
    }

    values.push(id);
    const query = `UPDATE mirs SET ${updateFields.join(", ")} WHERE mir_id = $${counter} RETURNING *`;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "MIR not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error updating MIR:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * @swagger
 * /api/mir/{id}:
 *   delete:
 *     summary: Delete a MIR
 *     tags: [MIR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: MIR deleted successfully
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("DELETE FROM mirs WHERE mir_id = $1 RETURNING *", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "MIR not found" });
    }

    res.json({ message: "MIR deleted successfully" });
  } catch (error) {
    console.error("Error deleting MIR:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
