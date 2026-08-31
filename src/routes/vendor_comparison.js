const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { logActivity, getEntityHistory, attachCreatedUpdatedBy } = require("./dashboard");

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
 *   description: |
 *     Stage 1 of the vendor comparison workflow — create and edit a side-by-side
 *     comparison of multiple vendors' pricelists for a PR. Once a vendor is
 *     chosen, use the **VendorComparisonFinalize** endpoints (POST/GET/PUT
 *     `/api/vendor-comparison-finalize`) to record the decision — that stage
 *     updates the SAME underlying record (matched by project_id + pr_no).
 *
 *     Every GET (list/by-id/by-project) response also includes
 *     created_by/created_by_name/updated_by/updated_by_name — see the
 *     CreatedUpdatedBy schema.
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
 *         vendorlist:
 *           type: array
 *           description: Stage 1 — one entry per vendor being compared, each with its own pricelist
 *           items:
 *             type: object
 *             properties:
 *               vendor_id:
 *                 type: integer
 *               vendor_name:
 *                 type: string
 *               pricelist:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     item_no:
 *                       type: string
 *                       description: BOQ item number for this line (optional, same as boqs.item_code)
 *                     item_code:
 *                       type: string
 *                       description: Item code / SKU for this line (optional)
 *                     item_description:
 *                       type: string
 *                     total_qty:
 *                       type: number
 *                     rate:
 *                       type: number
 *                     amount:
 *                       type: number
 *                     discount:
 *                       type: number
 *                     sgst:
 *                       type: number
 *                     cgst:
 *                       type: number
 *                     payment_terms:
 *                       type: string
 *         approved_vendor:
 *           type: integer
 *           description: Set by Stage 2 (POST /api/vendor-comparison-finalize) — link to the chosen vendor (vendors.vendor_id)
 *         pricelist:
 *           type: array
 *           description: Set by Stage 2 — the winning vendor's flat line items (see VendorComparisonFinalize schema)
 *           items:
 *             type: object
 *         upload_document:
 *           type: array
 *           description: Set by Stage 2 — approval/supporting documents
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
 *     summary: "Stage 1: Create a new vendor comparison (multiple vendors side by side)"
 *     tags: [VendorComparison]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [project_id, pr_no, vendorlist]
 *             properties:
 *               project_id: { type: integer }
 *               pr_no: { type: integer }
 *               user_id: { type: string, description: "Who is creating this comparison (recorded as created_by)" }
 *               user_name: { type: string }
 *               vendorlist:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     vendor_id: { type: string }
 *                     vendor_name: { type: string }
 *                     pricelist:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           item_no: { type: string, description: "BOQ item number for this line (optional)" }
 *                           item_code: { type: string, description: "Item code / SKU for this line (optional)" }
 *                           item_description: { type: string }
 *                           total_qty: { type: number }
 *                           rate: { type: number }
 *                           amount: { type: number }
 *                           discount: { type: number }
 *                           sgst: { type: number }
 *                           cgst: { type: number }
 *                           payment_terms: { type: string }
 *           example:
 *             project_id: 1
 *             pr_no: 5
 *             vendorlist:
 *               - vendor_id: "12"
 *                 vendor_name: "ABC Traders"
 *                 pricelist:
 *                   - item_no: "1.01.3"
 *                     item_code: "995468"
 *                     item_description: "Cables Supply, laying, testing..."
 *                     total_qty: 20
 *                     rate: 210
 *                     amount: 4200
 *                     discount: 0
 *                     sgst: 9
 *                     cgst: 9
 *                     payment_terms: "50% advance, 50% on delivery"
 *               - vendor_id: "18"
 *                 vendor_name: "XYZ Suppliers"
 *                 pricelist:
 *                   - item_no: "1.01.3"
 *                     item_code: "995468"
 *                     item_description: "Cables Supply, laying, testing..."
 *                     total_qty: 20
 *                     rate: 198
 *                     amount: 3960
 *                     discount: 0
 *                     sgst: 9
 *                     cgst: 9
 *                     payment_terms: "100% within 30 days of delivery"
 *     responses:
 *       201:
 *         description: Created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/VendorComparison'
 *       400:
 *         description: Invalid project_id or pr_no
 */
router.post("/", async (req, res) => {
  try {
    const { project_id, pr_no, vendorlist, user_id, user_name } = req.body;

    const result = await pool.query(
      `INSERT INTO vendor_comparisons (project_id, pr_no, vendorlist)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [
        project_id,
        pr_no,
        JSON.stringify(vendorlist || []),
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
    if (error.code === "23503" && error.constraint === "vendor_comparisons_pr_no_fkey")
      return res.status(400).json({ error: "Invalid pr_no: no Purchase Requisition with that internal pr_id exists" });
    if (error.code === "23503")
      return res.status(400).json({ error: "Invalid project_id: Project does not exist" });
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
 *       - in: query
 *         name: pr_name
 *         schema: { type: string }
 *         description: Filter by Purchase Requisition (project) name
 *     responses:
 *       200:
 *         description: List of vendor comparisons
 */
router.get("/", async (req, res) => {
  try {
    const { project_id, pr_no, pr_name } = req.query;
    let query = `
      SELECT vc.*, pr.project_name as pr_name, v.vendor_name as approved_vendor_name
      FROM vendor_comparisons vc
      LEFT JOIN purchase_requisitions pr ON vc.pr_no = pr.pr_id
      LEFT JOIN vendors v ON vc.approved_vendor = v.vendor_id
    `;
    let conditions = [];
    let params = [];

    if (project_id) {
      params.push(project_id);
      conditions.push(`vc.project_id = $${params.length}`);
    }
    if (pr_no) {
      params.push(pr_no);
      conditions.push(`vc.pr_no = $${params.length}`);
    }
    if (pr_name) {
      params.push(`%${pr_name}%`);
      conditions.push(`pr.project_name ILIKE $${params.length}`);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " ORDER BY vc.created_at DESC";
    const result = await pool.query(query, params);
    res.json(await attachCreatedUpdatedBy(result.rows, "vendor_comparison", (r) => r.comparison_id));
  } catch (error) {
    console.error("Error fetching vendor comparisons:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vendor-comparison/project/:projectId
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/vendor-comparison/project/{projectId}:
 *   get:
 *     summary: Get all vendor comparisons for a specific project
 *     tags: [VendorComparison]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: List of vendor comparisons for the project
 *       404:
 *         description: No vendor comparisons found for this project
 */
router.get("/project/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;
    const result = await pool.query(
      `SELECT vc.*, pr.project_name as pr_name, v.vendor_name as approved_vendor_name
         FROM vendor_comparisons vc
         LEFT JOIN purchase_requisitions pr ON vc.pr_no = pr.pr_id
         LEFT JOIN vendors v ON vc.approved_vendor = v.vendor_id
        WHERE vc.project_id = $1
        ORDER BY vc.created_at DESC`,
      [projectId]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "No vendor comparisons found for this project" });

    res.json(await attachCreatedUpdatedBy(result.rows, "vendor_comparison", (r) => r.comparison_id));
  } catch (error) {
    console.error("Error fetching vendor comparisons by project:", error);
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
      `SELECT vc.*, pr.project_name as pr_name, v.vendor_name as approved_vendor_name
         FROM vendor_comparisons vc
         LEFT JOIN purchase_requisitions pr ON vc.pr_no = pr.pr_id
         LEFT JOIN vendors v ON vc.approved_vendor = v.vendor_id
        WHERE vc.comparison_id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Vendor comparison not found" });
    res.json(await attachCreatedUpdatedBy(result.rows[0], "vendor_comparison", (r) => r.comparison_id));
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
 *     summary: "Stage 1: Update a vendor comparison's pr_no / vendorlist"
 *     description: |
 *       Only touches pr_no and vendorlist. To record the chosen vendor
 *       (approved_vendor / pricelist / upload_document), use
 *       PUT /api/vendor-comparison-finalize/{id} instead.
 *     tags: [VendorComparison]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               pr_no: { type: integer }
 *               vendorlist:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     vendor_id: { type: string }
 *                     vendor_name: { type: string }
 *                     pricelist:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           item_no: { type: string }
 *                           item_code: { type: string }
 *                           item_description: { type: string }
 *                           total_qty: { type: number }
 *                           rate: { type: number }
 *                           amount: { type: number }
 *                           discount: { type: number }
 *                           sgst: { type: number }
 *                           cgst: { type: number }
 *                           payment_terms: { type: string }
 *               user_id: { type: string, description: "Who is making this update (recorded as updated_by)" }
 *               user_name: { type: string }
 *     responses:
 *       200:
 *         description: Updated
 *       404:
 *         description: Not found
 */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { pr_no, vendorlist, user_id, user_name } = req.body;

    const result = await pool.query(
      `UPDATE vendor_comparisons SET
         pr_no = COALESCE($1, pr_no),
         vendorlist = COALESCE($2, vendorlist),
         updated_at = CURRENT_TIMESTAMP
       WHERE comparison_id = $3
       RETURNING *`,
      [
        pr_no || null,
        vendorlist ? JSON.stringify(vendorlist) : null,
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
    if (error.code === "23503" && error.constraint === "vendor_comparisons_pr_no_fkey")
      return res.status(400).json({ error: "Invalid pr_no: no Purchase Requisition with that internal pr_id exists" });
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
    const { user_id, user_name } = req.body || {};

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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vendor-comparison/:id/history — who created/updated/deleted this comparison, and when
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/vendor-comparison/{id}/history:
 *   get:
 *     summary: Get the create/update/delete history for a vendor comparison (who did what, and when)
 *     tags: [VendorComparison]
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
 *         description: Activity history for this vendor comparison (covers both Stage 1 and Stage 2 — the finalize endpoints update the same record)
 */
router.get("/:id/history", async (req, res) => {
  try {
    const data = await getEntityHistory("vendor_comparison", req.params.id, {
      limit: req.query.limit, offset: req.query.offset,
    });
    res.json(data);
  } catch (error) {
    console.error("Error fetching vendor comparison history:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
