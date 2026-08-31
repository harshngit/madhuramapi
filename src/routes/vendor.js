const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { logActivity, getEntityHistory, attachCreatedUpdatedBy } = require("./dashboard"); // adjust path if needed

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
 *         vendor_name:
 *           type: string
 *         vendor_company_name:
 *           type: string
 *         vendor_email:
 *           type: string
 *         mobile_number:
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
 *             required: [vendor_name]
 *             properties:
 *               vendor_name:
 *                 type: string
 *               vendor_company_name:
 *                 type: string
 *               vendor_email:
 *                 type: string
 *               mobile_number:
 *                 type: string
 *               location:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [active, inactive, blocked]
 *     responses:
 *       201:
 *         description: Vendor created successfully
 *       500:
 *         description: Internal server error
 */
router.post("/", async (req, res) => {
  const {
    vendor_name,
    vendor_company_name,
    vendor_email,
    mobile_number,
    location,
    status,
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO vendors (
        vendor_name, vendor_company_name, vendor_email, mobile_number, location, status
      ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        vendor_name,
        vendor_company_name,
        vendor_email,
        mobile_number,
        location,
        status || "active",
      ]
    );
    res.status(201).json(result.rows[0]);
    logActivity({
      action: "created",
      entity_type: "vendor",
      entity_id: result.rows[0].vendor_id,
      entity_name: result.rows[0].vendor_name,
      performed_by: req.body.created_by || null,
      performed_by_name: req.body.created_by_name || null,
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
 *     summary: Search vendors by name (partial match, case-insensitive)
 *     tags: [Vendors]
 *     parameters:
 *       - in: query
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Vendor name to search for
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
      "SELECT * FROM vendors WHERE vendor_name ILIKE $1 ORDER BY created_at DESC",
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
 *               vendor_name:
 *                 type: string
 *               vendor_company_name:
 *                 type: string
 *               vendor_email:
 *                 type: string
 *               mobile_number:
 *                 type: string
 *               location:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [active, inactive, blocked]
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
    vendor_name,
    vendor_company_name,
    vendor_email,
    mobile_number,
    location,
    status,
  } = req.body;

  try {
    const result = await pool.query(
      `UPDATE vendors SET
        vendor_name = COALESCE($1, vendor_name),
        vendor_company_name = COALESCE($2, vendor_company_name),
        vendor_email = COALESCE($3, vendor_email),
        mobile_number = COALESCE($4, mobile_number),
        location = COALESCE($5, location),
        status = COALESCE($6, status),
        updated_at = CURRENT_TIMESTAMP
      WHERE vendor_id = $7 RETURNING *`,
      [
        vendor_name,
        vendor_company_name,
        vendor_email,
        mobile_number,
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
      entity_name: result.rows[0].vendor_name,
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
      entity_name: result.rows[0].vendor_name,
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
      entity_name: result.rows[0].vendor_name,
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
