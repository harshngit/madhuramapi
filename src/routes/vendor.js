const express = require("express");
const router = express.Router();
const { pool } = require("../db");

/**
 * @swagger
 * tags:
 *   name: Vendors
 *   description: Vendor management
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
 *         project_id:
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
 *               project_id:
 *                 type: integer
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
    project_id,
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
        project_id, vendor_name, vendor_company_name, vendor_email, mobile_number, location, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        project_id,
        vendor_name,
        vendor_company_name,
        vendor_email,
        mobile_number,
        location,
        status || "active",
      ]
    );
    res.status(201).json(result.rows[0]);
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
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching vendors:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/vendors/project/{projectId}:
 *   get:
 *     summary: Get all vendors for a specific project
 *     tags: [Vendors]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of vendors
 *       500:
 *         description: Internal server error
 */
router.get("/project/:projectId", async (req, res) => {
  const { projectId } = req.params;
  try {
    const result = await pool.query("SELECT * FROM vendors WHERE project_id = $1 ORDER BY created_at DESC", [projectId]);
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching vendors by project:", error);
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
    res.json(result.rows[0]);
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
 *               project_id:
 *                 type: integer
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
    project_id,
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
        project_id = COALESCE($1, project_id),
        vendor_name = COALESCE($2, vendor_name),
        vendor_company_name = COALESCE($3, vendor_company_name),
        vendor_email = COALESCE($4, vendor_email),
        mobile_number = COALESCE($5, mobile_number),
        location = COALESCE($6, location),
        status = COALESCE($7, status),
        updated_at = CURRENT_TIMESTAMP
      WHERE vendor_id = $8 RETURNING *`,
      [
        project_id,
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
  } catch (error) {
    console.error("Error deleting vendor:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
