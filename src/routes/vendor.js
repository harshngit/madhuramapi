const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { logActivity, getEntityHistory, attachCreatedUpdatedBy } = require("./dashboard"); // adjust path if needed

// Display name for activity_log entries — vendor_name moved from a single
// scalar column into vendor_details[] (multiple contacts), so there's no
// longer one canonical "the" vendor name; prefer the company name, then the
// first contact's name, then a fallback.
function vendorDisplayName(row) {
  return row.vendor_company_name || row.vendor_details?.[0]?.vendor_name || `Vendor #${row.vendor_id}`;
}

/**
 * @swagger
 * tags:
 *   name: Vendors
 *   description: |
 *     Vendor management. Every GET (list/by-id) response also includes
 *     created_by/created_by_name/updated_by/updated_by_name — see the
 *     CreatedUpdatedBy schema.
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Vendor:
 *       type: object
 *       properties:
 *         vendor_id:
 *           type: integer
 *         vendor_details:
 *           type: array
 *           description: One or more contact people for this vendor company
 *           items:
 *             type: object
 *             properties:
 *               vendor_name:
 *                 type: string
 *               vendor_email:
 *                 type: string
 *               mobile_number:
 *                 type: string
 *         vendor_company_name:
 *           type: string
 *         location:
 *           type: string
 *         status:
 *           type: string
 *           enum: [active, inactive, blocked]
 *         created_at:
 *           type: string
 *           format: date-time
 */

/**
 * @swagger
 * /api/vendors:
 *   post:
 *     summary: Create a new vendor
 *     tags: [Vendors]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               vendor_details:
 *                 type: array
 *                 description: One or more contact people for this vendor company
 *                 items:
 *                   type: object
 *                   properties:
 *                     vendor_name:
 *                       type: string
 *                       example: "Ramesh Shah"
 *                     vendor_email:
 *                       type: string
 *                       example: "ramesh@abctraders.com"
 *                     mobile_number:
 *                       type: string
 *                       example: "9876543210"
 *               vendor_company_name:
 *                 type: string
 *                 example: "ABC Traders"
 *               location:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [active, inactive, blocked]
 *               user_id:
 *                 type: string
 *                 description: Who is creating this vendor (recorded as created_by)
 *               user_name:
 *                 type: string
 *           example:
 *             vendor_details:
 *               - vendor_name: "Ramesh Shah"
 *                 vendor_email: "ramesh@abctraders.com"
 *                 mobile_number: "9876543210"
 *             vendor_company_name: "ABC Traders"
 *             location: "Mumbai"
 *             status: "active"
 *             user_id: "123"
 *             user_name: "John Doe"
 *     responses:
 *       201:
 *         description: Vendor created successfully
 *       500:
 *         description: Internal server error
 */
router.post("/", async (req, res) => {
  const {
    vendor_details,
    vendor_company_name,
    location,
    status,
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO vendors (
        vendor_details, vendor_company_name, location, status
      ) VALUES ($1, $2, $3, $4) RETURNING *`,
      [
        JSON.stringify(vendor_details || []),
        vendor_company_name,
        location,
        status || "active",
      ]
    );
    res.status(201).json(result.rows[0]);
    logActivity({
      action: "created",
      entity_type: "vendor",
      entity_id: result.rows[0].vendor_id,
      entity_name: vendorDisplayName(result.rows[0]),
      performed_by: req.body.user_id || req.body.created_by || null,
      performed_by_name: req.body.user_name || req.body.created_by_name || null,
      meta: {},
    });
  } catch (error) {
    console.error("Error creating vendor:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/vendors:
 *   get:
 *     summary: Get all vendors
 *     tags: [Vendors]
 *     responses:
 *       200:
 *         description: List of vendors
 *       500:
 *         description: Internal server error
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM vendors ORDER BY created_at DESC");
    res.json(await attachCreatedUpdatedBy(result.rows, "vendor", (r) => r.vendor_id));
  } catch (error) {
    console.error("Error fetching vendors:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/vendors/search:
 *   get:
 *     summary: Search vendors by contact name (partial match, case-insensitive, matches any entry in vendor_details)
 *     tags: [Vendors]
 *     parameters:
 *       - in: query
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Vendor contact name to search for (matches vendor_details[].vendor_name)
 *     responses:
 *       200:
 *         description: Matching vendors
 *       500:
 *         description: Internal server error
 */
router.get("/search", async (req, res) => {
  const { name } = req.query;
  if (!name) {
    return res.status(400).json({ error: "name query parameter is required" });
  }
  try {
    const result = await pool.query(
      `SELECT * FROM vendors v
        WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements(v.vendor_details) elem
           WHERE elem->>'vendor_name' ILIKE $1
        )
        ORDER BY created_at DESC`,
      [`%${name}%`]
    );
    res.json(await attachCreatedUpdatedBy(result.rows, "vendor", (r) => r.vendor_id));
  } catch (error) {
    console.error("Error searching vendors:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/vendors/{id}:
 *   get:
 *     summary: Get a single vendor by ID
 *     tags: [Vendors]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Vendor details
 *       404:
 *         description: Vendor not found
 *       500:
 *         description: Internal server error
 */
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("SELECT * FROM vendors WHERE vendor_id = $1", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Vendor not found" });
    }
    res.json(await attachCreatedUpdatedBy(result.rows[0], "vendor", (r) => r.vendor_id));
  } catch (error) {
    console.error("Error fetching vendor:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/vendors/{id}:
 *   put:
 *     summary: Update an existing vendor
 *     tags: [Vendors]
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
 *             type: object
 *             properties:
 *               vendor_details:
 *                 type: array
 *                 description: One or more contact people for this vendor company (full replacement of the array)
 *                 items:
 *                   type: object
 *                   properties:
 *                     vendor_name:
 *                       type: string
 *                     vendor_email:
 *                       type: string
 *                     mobile_number:
 *                       type: string
 *               vendor_company_name:
 *                 type: string
 *               location:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [active, inactive, blocked]
 *               user_id:
 *                 type: string
 *                 description: Who is making this update (recorded as updated_by)
 *     responses:
 *       200:
 *         description: Vendor updated successfully
 *       404:
 *         description: Vendor not found
 *       500:
 *         description: Internal server error
 */
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const {
    vendor_details,
    vendor_company_name,
    location,
    status,
  } = req.body;

  try {
    const result = await pool.query(
      `UPDATE vendors SET
        vendor_details = COALESCE($1, vendor_details),
        vendor_company_name = COALESCE($2, vendor_company_name),
        location = COALESCE($3, location),
        status = COALESCE($4, status),
        updated_at = CURRENT_TIMESTAMP
      WHERE vendor_id = $5 RETURNING *`,
      [
        vendor_details ? JSON.stringify(vendor_details) : null,
        vendor_company_name,
        location,
        status,
        id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Vendor not found" });
    }
    res.json(result.rows[0]);

    // Log Activity
    logActivity({
      action: "updated",
      entity_type: "vendor",
      entity_id: id,
      entity_name: vendorDisplayName(result.rows[0]),
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      meta: { updates: req.body }
    });
  } catch (error) {
    console.error("Error updating vendor:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/vendors/{id}/status:
 *   patch:
 *     summary: Update vendor status
 *     tags: [Vendors]
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
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [active, inactive, blocked]
 *     responses:
 *       200:
 *         description: Vendor status updated successfully
 *       404:
 *         description: Vendor not found
 *       500:
 *         description: Internal server error
 */
router.patch("/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!["active", "inactive", "blocked"].includes(status)) {
    return res.status(400).json({ error: "Invalid status value" });
  }

  try {
    const result = await pool.query(
      "UPDATE vendors SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE vendor_id = $2 RETURNING *",
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Vendor not found" });
    }
    res.json(result.rows[0]);

    // Log Activity
    logActivity({
      action: "updated",
      entity_type: "vendor",
      entity_id: id,
      entity_name: vendorDisplayName(result.rows[0]),
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      meta: { status_change: status }
    });
  } catch (error) {
    console.error("Error updating vendor status:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/vendors/{id}:
 *   delete:
 *     summary: Delete a vendor
 *     tags: [Vendors]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Vendor deleted successfully
 *       404:
 *         description: Vendor not found
 *       500:
 *         description: Internal server error
 */
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("DELETE FROM vendors WHERE vendor_id = $1 RETURNING *", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Vendor not found" });
    }
    res.json({ message: "Vendor deleted successfully" });
    logActivity({
      action: "deleted",
      entity_type: "vendor",
      entity_id: id,
      entity_name: vendorDisplayName(result.rows[0]),
      performed_by: req.query.user_id || null,
      performed_by_name: req.query.user_name || null,
      meta: {}
    });
  } catch (error) {
    console.error("Error deleting vendor:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vendors/:id/history — who created/updated/deleted this vendor, and when
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/vendors/{id}/history:
 *   get:
 *     summary: Get the create/update/delete history for a vendor (who did what, and when)
 *     tags: [Vendors]
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
 *         description: Activity history for this vendor
 */
router.get("/:id/history", async (req, res) => {
  try {
    const data = await getEntityHistory("vendor", req.params.id, {
      limit: req.query.limit, offset: req.query.offset,
    });
    res.json(data);
  } catch (error) {
    console.error("Error fetching vendor history:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
