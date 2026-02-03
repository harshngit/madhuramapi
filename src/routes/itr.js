const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Ensure upload directory exists
const uploadDir = path.join(__dirname, "../../uploads/itr");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Keep original extension, prepend timestamp for uniqueness
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({ storage: storage });

/**
 * @swagger
 * tags:
 *   name: ITR
 *   description: Inspection Test Request management
 */

/**
 * @swagger
 * /api/itr/upload:
 *   post:
 *     summary: Upload a file for ITR
 *     tags: [ITR]
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
 *       400:
 *         description: No file uploaded
 */
router.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  // Return the relative path to be stored in the database
  const filePath = `/uploads/itr/${req.file.filename}`;
  res.json({ filePath });
});

/**
 * @swagger
 * /api/itr:
 *   post:
 *     summary: Create a new ITR
 *     tags: [ITR]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               project_id:
 *                 type: integer
 *               header_details:
 *                 type: object
 *                 properties:
 *                   project_name:
 *                     type: string
 *                   project_code:
 *                     type: string
 *                   client:
 *                     type: string
 *                   pmc:
 *                     type: string
 *                   contractor:
 *                     type: string
 *                   vendor_code:
 *                     type: string
 *                   material_code:
 *                     type: string
 *                   WIR_no:
 *                     type: string
 *                   wirdate:
 *                     type: string
 *                     format: date
 *                   inspection_date:
 *                     type: string
 *                     format: date
 *               contractor_details:
 *                 type: object
 *                 properties:
 *                   tower:
 *                     type: string
 *                   floor:
 *                     type: string
 *                   grid_refrence:
 *                     type: string
 *                   room:
 *                     type: string
 *                   previous_qty:
 *                     type: number
 *                   current_qty:
 *                     type: number
 *                   cumulative_qty:
 *                     type: number
 *                   description:
 *                     type: string
 *                   discipline:
 *                     type: string
 *                   drawingattach:
 *                     type: string
 *                   attachtest:
 *                     type: string
 *                   method_Statement:
 *                     type: string
 *                   checklist:
 *                     type: string
 *                   jointMeasurement:
 *                     type: string
 *               mep_clearance:
 *                 type: object
 *                 properties:
 *                   name:
 *                     type: string
 *                   date:
 *                     type: string
 *                     format: date
 *                   desgination:
 *                     type: string
 *                   signature:
 *                     type: string
 *                   comments:
 *                     type: string
 *               surveyor_clearance:
 *                 type: object
 *                 properties:
 *                   name:
 *                     type: string
 *                   date:
 *                     type: string
 *                     format: date
 *                   desgination:
 *                     type: string
 *                   signature:
 *                     type: string
 *                   comments:
 *                     type: string
 *               interface_clearance:
 *                 type: object
 *                 properties:
 *                   name:
 *                     type: string
 *                   date:
 *                     type: string
 *                     format: date
 *                   desgination:
 *                     type: string
 *                   signature:
 *                     type: string
 *                   comments:
 *                     type: string
 *               contract_manager:
 *                 type: object
 *                 properties:
 *                   Contract_manager:
 *                     type: string
 *                   inspection_date:
 *                     type: string
 *                     format: date
 *                   inspection_time:
 *                     type: string
 *                   signed_by:
 *                     type: string
 *               pmc_comments:
 *                 type: string
 *               engineer_civil:
 *                 type: object
 *                 properties:
 *                   name:
 *                     type: string
 *                   signature:
 *                     type: string
 *                   date:
 *                     type: string
 *                     format: date
 *               engineer_mep:
 *                 type: object
 *                 properties:
 *                   name:
 *                     type: string
 *                   signature:
 *                     type: string
 *                   date:
 *                     type: string
 *                     format: date
 *               tower_incharge:
 *                 type: object
 *                 properties:
 *                   name:
 *                     type: string
 *                   signature:
 *                     type: string
 *                   date:
 *                     type: string
 *                     format: date
 *               qaa_department:
 *                 type: object
 *                 properties:
 *                   name:
 *                     type: string
 *                   signature:
 *                     type: string
 *                   date:
 *                     type: string
 *                     format: date
 *               result_code:
 *                 type: string
 *     responses:
 *       201:
 *         description: ITR created successfully
 *       500:
 *         description: Internal server error
 */
router.post("/", async (req, res) => {
  const {
    project_id,
    header_details,
    contractor_details,
    mep_clearance,
    surveyor_clearance,
    interface_clearance,
    contract_manager,
    pmc_comments,
    engineer_civil,
    engineer_mep,
    tower_incharge,
    qaa_department,
    result_code,
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO itrs (
        project_id, header_details, contractor_details, mep_clearance, 
        surveyor_clearance, interface_clearance, contract_manager, 
        pmc_comments, engineer_civil, engineer_mep, tower_incharge, 
        qaa_department, result_code
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [
        project_id,
        JSON.stringify(header_details || {}),
        JSON.stringify(contractor_details || {}),
        JSON.stringify(mep_clearance || {}),
        JSON.stringify(surveyor_clearance || {}),
        JSON.stringify(interface_clearance || {}),
        JSON.stringify(contract_manager || {}),
        pmc_comments,
        JSON.stringify(engineer_civil || {}),
        JSON.stringify(engineer_mep || {}),
        JSON.stringify(tower_incharge || {}),
        JSON.stringify(qaa_department || {}),
        result_code,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error creating ITR:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/itr/project/{projectId}:
 *   get:
 *     summary: Get all ITRs for a specific project
 *     tags: [ITR]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: integer
 *         description: Project ID
 *     responses:
 *       200:
 *         description: List of ITRs
 *       500:
 *         description: Internal server error
 */
router.get("/project/:projectId", async (req, res) => {
  const { projectId } = req.params;
  try {
    const result = await pool.query("SELECT * FROM itrs WHERE project_id = $1 ORDER BY created_at DESC", [projectId]);
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching ITRs:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/itr/{id}:
 *   get:
 *     summary: Get a single ITR by ID
 *     tags: [ITR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ITR ID
 *     responses:
 *       200:
 *         description: ITR details
 *       404:
 *         description: ITR not found
 *       500:
 *         description: Internal server error
 */
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("SELECT * FROM itrs WHERE itr_id = $1", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "ITR not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching ITR:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/itr/{id}:
 *   put:
 *     summary: Update an existing ITR
 *     tags: [ITR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ITR ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ITRUpdate' 
 *     responses:
 *       200:
 *         description: ITR updated successfully
 *       404:
 *         description: ITR not found
 *       500:
 *         description: Internal server error
 */
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const {
    header_details,
    contractor_details,
    mep_clearance,
    surveyor_clearance,
    interface_clearance,
    contract_manager,
    pmc_comments,
    engineer_civil,
    engineer_mep,
    tower_incharge,
    qaa_department,
    result_code,
  } = req.body;

  try {
    const result = await pool.query(
      `UPDATE itrs SET
        header_details = COALESCE($1, header_details),
        contractor_details = COALESCE($2, contractor_details),
        mep_clearance = COALESCE($3, mep_clearance),
        surveyor_clearance = COALESCE($4, surveyor_clearance),
        interface_clearance = COALESCE($5, interface_clearance),
        contract_manager = COALESCE($6, contract_manager),
        pmc_comments = COALESCE($7, pmc_comments),
        engineer_civil = COALESCE($8, engineer_civil),
        engineer_mep = COALESCE($9, engineer_mep),
        tower_incharge = COALESCE($10, tower_incharge),
        qaa_department = COALESCE($11, qaa_department),
        result_code = COALESCE($12, result_code),
        updated_at = CURRENT_TIMESTAMP
      WHERE itr_id = $13 RETURNING *`,
      [
        header_details ? JSON.stringify(header_details) : null,
        contractor_details ? JSON.stringify(contractor_details) : null,
        mep_clearance ? JSON.stringify(mep_clearance) : null,
        surveyor_clearance ? JSON.stringify(surveyor_clearance) : null,
        interface_clearance ? JSON.stringify(interface_clearance) : null,
        contract_manager ? JSON.stringify(contract_manager) : null,
        pmc_comments,
        engineer_civil ? JSON.stringify(engineer_civil) : null,
        engineer_mep ? JSON.stringify(engineer_mep) : null,
        tower_incharge ? JSON.stringify(tower_incharge) : null,
        qaa_department ? JSON.stringify(qaa_department) : null,
        result_code,
        id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "ITR not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error updating ITR:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/itr/{id}:
 *   delete:
 *     summary: Delete an ITR
 *     tags: [ITR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ITR ID
 *     responses:
 *       200:
 *         description: ITR deleted successfully
 *       404:
 *         description: ITR not found
 *       500:
 *         description: Internal server error
 */
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("DELETE FROM itrs WHERE itr_id = $1 RETURNING *", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "ITR not found" });
    }
    res.json({ message: "ITR deleted successfully" });
  } catch (error) {
    console.error("Error deleting ITR:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
