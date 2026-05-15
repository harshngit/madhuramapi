const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { logActivity } = require("./dashboard");

// Ensure upload directory exists
const uploadDir = path.join(__dirname, "../../uploads/vendor_comparison");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Configure Multer for document uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const u = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, u + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

/**
 * @swagger
 * tags:
 *   name: VendorComparison
 *   description: Vendor Comparison management
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     VendorComparison:
 *       type: object
 *       properties:
 *         comparison_id:
 *           type: integer
 *         project_id:
 *           type: integer
 *         pr_no:
 *           type: integer
 *         pricelist:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               vendor_name:
 *                 type: string
 *               item_description:
 *                 type: string
 *               total_qty:
 *                 type: number
 *               rate:
 *                 type: number
 *               amount:
 *                 type: number
 *         upload_document:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               file_name:
 *                 type: string
 *               file_url:
 *                 type: string
 *         created_at:
 *           type: string
 *           format: date-time
 *         updated_at:
 *           type: string
 *           format: date-time
 */

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vendor-comparison/upload
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/vendor-comparison/upload:
 *   post:
 *     summary: Upload documents for vendor comparison
 *     tags: [VendorComparison]
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               files:
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
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   file_name:
 *                     type: string
 *                   file_url:
 *                     type: string
 */
router.post("/upload", upload.array("files"), (req, res) => {
  if (!req.files || req.files.length === 0)
    return res.status(400).json({ error: "No files uploaded" });

  const fileData = req.files.map(f => ({
    file_name: f.originalname,
    file_url: `/uploads/vendor_comparison/${f.filename}`
  }));
  res.json(fileData);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vendor-comparison
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/vendor-comparison:
 *   post:
 *     summary: Create a new vendor comparison
 *     tags: [VendorComparison]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               project_id: { type: integer }
 *               pr_no: { type: integer }
 *               pricelist:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     vendor_name: { type: string }
 *                     item_description: { type: string }
 *                     total_qty: { type: number }
 *                     rate: { type: number }
 *                     amount: { type: number }
 *               upload_document:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     file_name: { type: string }
 *                     file_url: { type: string }
 *     responses:
 *       201:
 *         description: Created
 */
router.post("/", async (req, res) => {
  try {
    const { project_id, pr_no, pricelist, upload_document, user_id, user_name } = req.body;

    const result = await pool.query(
      `INSERT INTO vendor_comparisons (project_id, pr_no, pricelist, upload_document)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        project_id,
        pr_no,
        JSON.stringify(pricelist || []),
        JSON.stringify(upload_document || [])
      ]
    );

    const vc = result.rows[0];

    logActivity({
      action: "created",
      entity_type: "vendor_comparison",
      entity_id: vc.comparison_id,
      entity_name: `Comparison for PR #${pr_no}`,
      performed_by: user_id || null,
      performed_by_name: user_name || null,
      project_id: vc.project_id,
    });

    res.status(201).json(vc);
  } catch (error) {
    console.error("Error creating vendor comparison:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vendor-comparison
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/vendor-comparison:
 *   get:
 *     summary: Get all vendor comparisons
 *     tags: [VendorComparison]
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema: { type: integer }
 *       - in: query
 *         name: pr_no
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: List of vendor comparisons
 */
router.get("/", async (req, res) => {
  try {
    const { project_id, pr_no } = req.query;
    let query = "SELECT * FROM vendor_comparisons";
    let conditions = [];
    let params = [];

    if (project_id) {
      params.push(project_id);
      conditions.push(`project_id = $${params.length}`);
    }
    if (pr_no) {
      params.push(pr_no);
      conditions.push(`pr_no = $${params.length}`);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " ORDER BY created_at DESC";
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching vendor comparisons:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vendor-comparison/:id
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/vendor-comparison/{id}:
 *   get:
 *     summary: Get a single vendor comparison by ID
 *     tags: [VendorComparison]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Details of the vendor comparison
 *       404:
 *         description: Not found
 */
router.get("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM vendor_comparisons WHERE comparison_id = $1",
      [req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Vendor comparison not found" });
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching vendor comparison:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/vendor-comparison/:id
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/vendor-comparison/{id}:
 *   put:
 *     summary: Update a vendor comparison
 *     tags: [VendorComparison]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Updated
 *       404:
 *         description: Not found
 */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { pr_no, pricelist, upload_document, user_id, user_name } = req.body;

    const result = await pool.query(
      `UPDATE vendor_comparisons SET
         pr_no = COALESCE($1, pr_no),
         pricelist = COALESCE($2, pricelist),
         upload_document = COALESCE($3, upload_document),
         updated_at = CURRENT_TIMESTAMP
       WHERE comparison_id = $4
       RETURNING *`,
      [
        pr_no || null,
        pricelist ? JSON.stringify(pricelist) : null,
        upload_document ? JSON.stringify(upload_document) : null,
        id
      ]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "Vendor comparison not found" });

    const vc = result.rows[0];

    logActivity({
      action: "updated",
      entity_type: "vendor_comparison",
      entity_id: vc.comparison_id,
      entity_name: `Comparison for PR #${vc.pr_no}`,
      performed_by: user_id || null,
      performed_by_name: user_name || null,
      project_id: vc.project_id,
      meta: { updates: req.body }
    });

    res.json(vc);
  } catch (error) {
    console.error("Error updating vendor comparison:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/vendor-comparison/:id
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/vendor-comparison/{id}:
 *   delete:
 *     summary: Delete a vendor comparison
 *     tags: [VendorComparison]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Deleted
 *       404:
 *         description: Not found
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id, user_name } = req.body;

    const result = await pool.query(
      "DELETE FROM vendor_comparisons WHERE comparison_id = $1 RETURNING *",
      [id]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "Vendor comparison not found" });

    const vc = result.rows[0];

    logActivity({
      action: "deleted",
      entity_type: "vendor_comparison",
      entity_id: id,
      entity_name: `Comparison for PR #${vc.pr_no}`,
      performed_by: user_id || null,
      performed_by_name: user_name || null,
      project_id: vc.project_id,
    });

    res.json({ message: "Vendor comparison deleted" });
  } catch (error) {
    console.error("Error deleting vendor comparison:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
