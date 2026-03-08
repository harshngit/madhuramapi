const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { logActivity } = require("./dashboard"); // adjust path if needed


// Ensure upload directory exists
const uploadDir = path.join(__dirname, "../../uploads/po");
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
 *   name: PO
 *   description: Purchase Order management
 */

/**
 * @swagger
 * /api/po/upload:
 *   post:
 *     summary: Upload a file for PO
 *     tags: [PO]
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
  const filePath = `/uploads/po/${req.file.filename}`;
  res.json({ filePath });
});

/**
 * @swagger
 * /api/po:
 *   post:
 *     summary: Create a new Purchase Order (PO)
 *     tags: [PO]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               project_id:
 *                 type: integer
 *               sample_id:
 *                 type: integer
 *               company_name:
 *                 type: string
 *               company_subtitle:
 *                 type: string
 *               company_email:
 *                 type: string
 *               company_gst:
 *                 type: string
 *               indent_no:
 *                 type: string
 *               indent_date:
 *                 type: string
 *                 format: date
 *               order_no:
 *                 type: string
 *               po_date:
 *                 type: string
 *                 format: date
 *               vendor_name:
 *                 type: string
 *               site:
 *                 type: string
 *               contact_person:
 *                 type: string
 *               vendor_address:
 *                 type: string
 *               primary_contact_name:
 *                 type: string
 *               primary_contact_number:
 *                 type: string
 *               secondary_contact_number:
 *                 type: string
 *               secondary_contact_name:
 *                 type: string
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     srno:
 *                       type: integer
 *                     hsn:
 *                       type: string
 *                     description:
 *                       type: string
 *                     qty:
 *                       type: number
 *                     UOM:
 *                       type: string
 *                     Rate:
 *                       type: number
 *                     Amount:
 *                       type: number
 *                     remark:
 *                       type: string
 *               discount:
 *                 type: number
 *               discount_amount:
 *                 type: number
 *               after_discount:
 *                 type: number
 *               cgst:
 *                 type: number
 *               cgst_amount:
 *                 type: number
 *               sgst:
 *                 type: number
 *               sgst_amount:
 *                 type: number
 *               total_amount:
 *                 type: number
 *               delivery:
 *                 type: string
 *               payment:
 *                 type: string
 *               notes:
 *                 type: string
 *               status:
 *                 type: string
 *                 default: created
 *     responses:
 *       201:
 *         description: PO created successfully
 *       500:
 *         description: Internal server error
 */
router.post("/", async (req, res) => {
  const {
    project_id,
    sample_id,
    company_name,
    company_subtitle,
    company_email,
    company_gst,
    indent_no,
    indent_date,
    order_no,
    po_date,
    vendor_name,
    site,
    contact_person,
    vendor_address,
    primary_contact_name,
    primary_contact_number,
    secondary_contact_number,
    secondary_contact_name,
    items,
    discount,
    discount_amount,
    after_discount,
    cgst,
    cgst_amount,
    sgst,
    sgst_amount,
    total_amount,
    delivery,
    payment,
    notes,
    status,
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO pos (
        project_id, sample_id, company_name, company_subtitle, company_email, company_gst,
        indent_no, indent_date, order_no, po_date, vendor_name, site,
        contact_person, vendor_address, primary_contact_name, primary_contact_number,
        secondary_contact_number, secondary_contact_name, items, discount,
        discount_amount, after_discount, cgst, cgst_amount, sgst, sgst_amount,
        total_amount, delivery, payment, notes, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31) RETURNING *`,
      [
        project_id,
        sample_id || null,
        company_name,
        company_subtitle,
        company_email,
        company_gst,
        indent_no,
        indent_date,
        order_no,
        po_date,
        vendor_name,
        site,
        contact_person,
        vendor_address,
        primary_contact_name,
        primary_contact_number,
        secondary_contact_number,
        secondary_contact_name,
        JSON.stringify(items || []),
        discount,
        discount_amount,
        after_discount,
        cgst,
        cgst_amount,
        sgst,
        sgst_amount,
        total_amount,
        delivery,
        payment,
        notes,
        status || 'created',
      ]
    );
    res.status(201).json(result.rows[0]);
    logActivity({
  action: "created",
  entity_type: "po",
  entity_id: result.rows[0].po_id,
  entity_name: `PO #${result.rows[0].po_id}`,
  performed_by: req.body.created_by || null,
  performed_by_name: req.body.created_by_name || null,
  meta: {
    project_id: result.rows[0].project_id,
    sample_id: result.rows[0].sample_id,
    company_name: result.rows[0].company_name,
  },
});
  } catch (error) {
    console.error("Error creating PO:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/po/project/{projectId}:
 *   get:
 *     summary: Get all POs for a specific project
 *     tags: [PO]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: integer
 *         description: Project ID
 *     responses:
 *       200:
 *         description: List of POs
 *       500:
 *         description: Internal server error
 */
router.get("/project/:projectId", async (req, res) => {
  const { projectId } = req.params;
  try {
    const result = await pool.query("SELECT * FROM pos WHERE project_id = $1 ORDER BY created_at DESC", [projectId]);
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching POs:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/po/sample/{sampleId}:
 *   get:
 *     summary: Get all POs for a specific sample
 *     tags: [PO]
 *     parameters:
 *       - in: path
 *         name: sampleId
 *         required: true
 *         schema:
 *           type: integer
 *         description: Sample ID
 *     responses:
 *       200:
 *         description: List of POs for the sample
 *       500:
 *         description: Internal server error
 */
router.get("/sample/:sampleId", async (req, res) => {
  const { sampleId } = req.params;
  try {
    const result = await pool.query("SELECT * FROM pos WHERE sample_id = $1 ORDER BY created_at DESC", [sampleId]);
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching POs by sample:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/po/{id}:
 *   get:
 *     summary: Get a single PO by ID
 *     tags: [PO]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: PO ID
 *     responses:
 *       200:
 *         description: PO details
 *       404:
 *         description: PO not found
 *       500:
 *         description: Internal server error
 */
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("SELECT * FROM pos WHERE po_id = $1", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "PO not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching PO:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/po/{id}:
 *   put:
 *     summary: Update an existing PO
 *     tags: [PO]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: PO ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/POUpdate'
 *     responses:
 *       200:
 *         description: PO updated successfully
 *       404:
 *         description: PO not found
 *       500:
 *         description: Internal server error
 */
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const {
    sample_id,
    company_name,
    company_subtitle,
    company_email,
    company_gst,
    indent_no,
    indent_date,
    order_no,
    po_date,
    vendor_name,
    site,
    contact_person,
    vendor_address,
    primary_contact_name,
    primary_contact_number,
    secondary_contact_number,
    secondary_contact_name,
    items,
    discount,
    discount_amount,
    after_discount,
    cgst,
    cgst_amount,
    sgst,
    sgst_amount,
    total_amount,
    delivery,
    payment,
    notes,
    status,
  } = req.body;

  try {
    const result = await pool.query(
      `UPDATE pos SET
        sample_id = COALESCE($1, sample_id),
        company_name = COALESCE($2, company_name),
        company_subtitle = COALESCE($3, company_subtitle),
        company_email = COALESCE($4, company_email),
        company_gst = COALESCE($5, company_gst),
        indent_no = COALESCE($6, indent_no),
        indent_date = COALESCE($7, indent_date),
        order_no = COALESCE($8, order_no),
        po_date = COALESCE($9, po_date),
        vendor_name = COALESCE($10, vendor_name),
        site = COALESCE($11, site),
        contact_person = COALESCE($12, contact_person),
        vendor_address = COALESCE($13, vendor_address),
        primary_contact_name = COALESCE($14, primary_contact_name),
        primary_contact_number = COALESCE($15, primary_contact_number),
        secondary_contact_number = COALESCE($16, secondary_contact_number),
        secondary_contact_name = COALESCE($17, secondary_contact_name),
        items = COALESCE($18, items),
        discount = COALESCE($19, discount),
        discount_amount = COALESCE($20, discount_amount),
        after_discount = COALESCE($21, after_discount),
        cgst = COALESCE($22, cgst),
        cgst_amount = COALESCE($23, cgst_amount),
        sgst = COALESCE($24, sgst),
        sgst_amount = COALESCE($25, sgst_amount),
        total_amount = COALESCE($26, total_amount),
        delivery = COALESCE($27, delivery),
        payment = COALESCE($28, payment),
        notes = COALESCE($29, notes),
        status = COALESCE($30, status),
        updated_at = CURRENT_TIMESTAMP
      WHERE po_id = $31 RETURNING *`,
      [
        sample_id,
        company_name,
        company_subtitle,
        company_email,
        company_gst,
        indent_no,
        indent_date,
        order_no,
        po_date,
        vendor_name,
        site,
        contact_person,
        vendor_address,
        primary_contact_name,
        primary_contact_number,
        secondary_contact_number,
        secondary_contact_name,
        items ? JSON.stringify(items) : null,
        discount,
        discount_amount,
        after_discount,
        cgst,
        cgst_amount,
        sgst,
        sgst_amount,
        total_amount,
        delivery,
        payment,
        notes,
        status,
        id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "PO not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error updating PO:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/po/{id}:
 *   delete:
 *     summary: Delete a PO
 *     tags: [PO]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: PO ID
 *     responses:
 *       200:
 *         description: PO deleted successfully
 *       404:
 *         description: PO not found
 *       500:
 *         description: Internal server error
 */
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("DELETE FROM pos WHERE po_id = $1 RETURNING *", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "PO not found" });
    }
    res.json({ message: "PO deleted successfully" });
    logActivity({
  action: "deleted",
  entity_type: "po",
  entity_id: id,
  entity_name: `PO #${id}`,
  performed_by: null,
  performed_by_name: null,
});

  } catch (error) {
    console.error("Error deleting PO:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
