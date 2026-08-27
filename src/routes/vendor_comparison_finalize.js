const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { logActivity, getEntityHistory } = require("./dashboard");

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2 of the vendor comparison workflow. Operates on the SAME
// vendor_comparisons table/record as /api/vendor-comparison (Stage 1) — it
// is matched by (project_id, pr_no), not a separate table. To attach
// approval documents, upload them first via POST /api/vendor-comparison/upload
// and pass the returned { file_name, file_url } pairs in upload_document.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * tags:
 *   name: VendorComparisonFinalize
 *   description: |
 *     Stage 2 of the vendor comparison workflow — record which vendor was
 *     chosen after Stage 1 (POST /api/vendor-comparison) laid out the
 *     side-by-side comparison. POST here upserts the SAME record: if a
 *     comparison already exists for that project_id + pr_no it is updated
 *     in place (approved_vendor / pricelist / upload_document); otherwise a
 *     new record is created directly at the finalized state.
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     VendorComparisonFinalize:
 *       type: object
 *       properties:
 *         comparison_id:
 *           type: integer
 *         project_id:
 *           type: integer
 *         pr_no:
 *           type: integer
 *         approved_vendor:
 *           type: integer
 *           description: Link to the chosen vendor (vendors.vendor_id)
 *         pricelist:
 *           type: array
 *           description: The winning vendor's flat line items
 *           items:
 *             type: object
 *             properties:
 *               vendor_id: { type: integer }
 *               vendor_name: { type: string }
 *               item_no: { type: string, description: "BOQ item number for this line (optional)" }
 *               item_code: { type: string, description: "Item code / SKU for this line (optional)" }
 *               item_description: { type: string }
 *               total_qty: { type: number }
 *               rate: { type: number }
 *               amount: { type: number }
 *               discount: { type: number }
 *               sgst: { type: number }
 *               cgst: { type: number }
 *               payment_terms: { type: string }
 *         upload_document:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               file_name: { type: string }
 *               file_url: { type: string }
 *         vendorlist:
 *           type: array
 *           description: Stage 1 data, unchanged by this endpoint — see VendorComparison schema
 *           items:
 *             type: object
 *         created_at:
 *           type: string
 *           format: date-time
 *         updated_at:
 *           type: string
 *           format: date-time
 */

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vendor-comparison-finalize
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/vendor-comparison-finalize:
 *   post:
 *     summary: "Stage 2: Choose a vendor (finalize the comparison for a PR)"
 *     tags: [VendorComparisonFinalize]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [project_id, pr_no, approved_vendor]
 *             properties:
 *               project_id: { type: integer }
 *               pr_no: { type: integer }
 *               approved_vendor:
 *                 type: integer
 *                 description: Link to the chosen vendor (vendors.vendor_id)
 *               pricelist:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     vendor_id: { type: integer }
 *                     vendor_name: { type: string }
 *                     item_no: { type: string }
 *                     item_code: { type: string }
 *                     item_description: { type: string }
 *                     total_qty: { type: number }
 *                     rate: { type: number }
 *                     amount: { type: number }
 *                     discount: { type: number }
 *                     sgst: { type: number }
 *                     cgst: { type: number }
 *                     payment_terms: { type: string }
 *               upload_document:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     file_name: { type: string }
 *                     file_url: { type: string }
 *           example:
 *             project_id: 1
 *             pr_no: 5
 *             approved_vendor: 12
 *             pricelist:
 *               - vendor_id: 12
 *                 vendor_name: "ABC Traders"
 *                 item_no: "1.01.3"
 *                 item_code: "995468"
 *                 item_description: "Cables Supply, laying, testing..."
 *                 total_qty: 20
 *                 rate: 210
 *                 amount: 4200
 *                 discount: 0
 *                 sgst: 9
 *                 cgst: 9
 *                 payment_terms: "50% advance, 50% on delivery"
 *             upload_document:
 *               - file_name: "approval.pdf"
 *                 file_url: "/uploads/vendor_comparison/approval-123.pdf"
 *     responses:
 *       200:
 *         description: Existing comparison (matched by project_id + pr_no) updated with the finalized decision
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/VendorComparisonFinalize'
 *       201:
 *         description: No existing comparison for that project_id + pr_no — a new finalized record was created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/VendorComparisonFinalize'
 *       400:
 *         description: project_id/pr_no missing, or invalid project_id / pr_no / approved_vendor
 */
router.post("/", async (req, res) => {
  try {
    const { project_id, pr_no, approved_vendor, pricelist, upload_document, user_id, user_name } = req.body;

    if (!project_id || !pr_no)
      return res.status(400).json({ error: "project_id and pr_no are required" });

    const existing = await pool.query(
      `SELECT comparison_id FROM vendor_comparisons
        WHERE project_id = $1 AND pr_no = $2
        ORDER BY created_at DESC LIMIT 1`,
      [project_id, pr_no]
    );

    let result;
    let created = false;

    if (existing.rows.length > 0) {
      result = await pool.query(
        `UPDATE vendor_comparisons SET
           approved_vendor = $1,
           pricelist = $2,
           upload_document = $3,
           updated_at = CURRENT_TIMESTAMP
         WHERE comparison_id = $4
         RETURNING *`,
        [
          approved_vendor || null,
          JSON.stringify(pricelist || []),
          JSON.stringify(upload_document || []),
          existing.rows[0].comparison_id,
        ]
      );
    } else {
      created = true;
      result = await pool.query(
        `INSERT INTO vendor_comparisons (project_id, pr_no, approved_vendor, pricelist, upload_document)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
        [
          project_id,
          pr_no,
          approved_vendor || null,
          JSON.stringify(pricelist || []),
          JSON.stringify(upload_document || []),
        ]
      );
    }

    const vc = result.rows[0];

    logActivity({
      action: created ? "created" : "finalized",
      entity_type: "vendor_comparison",
      entity_id: vc.comparison_id,
      entity_name: `Comparison for PR #${pr_no}`,
      performed_by: user_id || null,
      performed_by_name: user_name || null,
      project_id: vc.project_id,
      meta: { approved_vendor: vc.approved_vendor },
    });

    res.status(created ? 201 : 200).json(vc);
  } catch (error) {
    console.error("Error finalizing vendor comparison:", error);
    if (error.code === "23503" && error.constraint === "vendor_comparisons_pr_no_fkey")
      return res.status(400).json({ error: "Invalid pr_no: no Purchase Requisition with that internal pr_id exists" });
    if (error.code === "23503" && error.constraint === "vendor_comparisons_approved_vendor_fkey")
      return res.status(400).json({ error: "Invalid approved_vendor: no vendor with that vendor_id exists" });
    if (error.code === "23503")
      return res.status(400).json({ error: "Invalid project_id: Project does not exist" });
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vendor-comparison-finalize/project/:projectId
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/vendor-comparison-finalize/project/{projectId}:
 *   get:
 *     summary: Get all finalized vendor comparisons (approved_vendor set) for a project
 *     tags: [VendorComparisonFinalize]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: List of finalized vendor comparisons for the project
 *       404:
 *         description: No finalized vendor comparisons found for this project
 */
router.get("/project/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;
    const result = await pool.query(
      `SELECT vc.*, pr.project_name as pr_name, v.vendor_name as approved_vendor_name
         FROM vendor_comparisons vc
         LEFT JOIN purchase_requisitions pr ON vc.pr_no = pr.pr_id
         LEFT JOIN vendors v ON vc.approved_vendor = v.vendor_id
        WHERE vc.project_id = $1 AND vc.approved_vendor IS NOT NULL
        ORDER BY vc.updated_at DESC`,
      [projectId]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "No finalized vendor comparisons found for this project" });

    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching finalized vendor comparisons by project:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vendor-comparison-finalize/:id
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/vendor-comparison-finalize/{id}:
 *   get:
 *     summary: Get a single (finalized) vendor comparison by ID
 *     tags: [VendorComparisonFinalize]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Details of the vendor comparison
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/VendorComparisonFinalize'
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
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching vendor comparison:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/vendor-comparison-finalize/:id
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/vendor-comparison-finalize/{id}:
 *   put:
 *     summary: "Stage 2: Edit the finalized decision (approved_vendor / pricelist / upload_document)"
 *     tags: [VendorComparisonFinalize]
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
 *               approved_vendor: { type: integer }
 *               pricelist:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     vendor_id: { type: integer }
 *                     vendor_name: { type: string }
 *                     item_no: { type: string }
 *                     item_code: { type: string }
 *                     item_description: { type: string }
 *                     total_qty: { type: number }
 *                     rate: { type: number }
 *                     amount: { type: number }
 *                     discount: { type: number }
 *                     sgst: { type: number }
 *                     cgst: { type: number }
 *                     payment_terms: { type: string }
 *               upload_document: { type: array, items: { type: object } }
 *     responses:
 *       200:
 *         description: Updated
 *       404:
 *         description: Not found
 */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { approved_vendor, pricelist, upload_document, user_id, user_name } = req.body;

    const result = await pool.query(
      `UPDATE vendor_comparisons SET
         approved_vendor = COALESCE($1, approved_vendor),
         pricelist = COALESCE($2, pricelist),
         upload_document = COALESCE($3, upload_document),
         updated_at = CURRENT_TIMESTAMP
       WHERE comparison_id = $4
       RETURNING *`,
      [
        approved_vendor || null,
        pricelist ? JSON.stringify(pricelist) : null,
        upload_document ? JSON.stringify(upload_document) : null,
        id
      ]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "Vendor comparison not found" });

    const vc = result.rows[0];

    logActivity({
      action: "finalized",
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
    console.error("Error updating finalized vendor comparison:", error);
    if (error.code === "23503" && error.constraint === "vendor_comparisons_approved_vendor_fkey")
      return res.status(400).json({ error: "Invalid approved_vendor: no vendor with that vendor_id exists" });
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vendor-comparison-finalize/:id/history — who created/updated/deleted this comparison, and when
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/vendor-comparison-finalize/{id}/history:
 *   get:
 *     summary: Get the create/update/delete history for a vendor comparison (who did what, and when)
 *     tags: [VendorComparisonFinalize]
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
 *         description: Activity history for this vendor comparison (same underlying record as Stage 1)
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
