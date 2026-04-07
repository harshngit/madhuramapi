const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");
const { generatePOPdf } = require("../utils/po_pdf");
const { logActivity } = require("./dashboard"); // adjust path if needed
const { generateEmailTemplate, formatCurrency, formatDate } = require("../utils/emailHelper");


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

  if (req.body.user_id) {
    logActivity({
      action: "uploaded",
      entity_type: "po_file",
      entity_id: null,
      entity_name: req.file.originalname,
      performed_by: req.body.user_id,
      performed_by_name: req.body.user_name || null,
      meta: { filePath }
    });
  }
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
    const pos = result.rows.map(po => {
      const items = Array.isArray(po.items) ? po.items : [];
      const linked = items.length > 0 && items.every(i => i.inventory_id);
      return { ...po, linked };
    });
    res.json(pos);
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
    const pos = result.rows.map(po => {
      const items = Array.isArray(po.items) ? po.items : [];
      const linked = items.length > 0 && items.every(i => i.inventory_id);
      return { ...po, linked };
    });
    res.json(pos);
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

    // Log Activity
    logActivity({
      action: "updated",
      entity_type: "po",
      entity_id: id,
      entity_name: `PO #${result.rows[0].po_id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: result.rows[0].project_id,
      meta: { updates: req.body }
    });
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

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 1: Generate PO PDF from DB and return as download
// GET /api/po/:id/pdf
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/po/{id}/pdf:
 *   get:
 *     summary: Generate and download a PDF for a PO
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
 *         description: PDF file stream
 *         content:
 *           application/pdf:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: PO not found
 *       500:
 *         description: Internal server error
 */
router.get("/:id/pdf", async (req, res) => {
  const { id } = req.params;
  try {
    // 1. Fetch PO from DB
    const result = await pool.query("SELECT * FROM pos WHERE po_id = $1", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "PO not found" });
    }

    const po = result.rows[0];

    // 2. Generate PDF buffer
    const pdfBuffer = await generatePOPdf(po);

    // 3. Send as downloadable PDF
    const filename = `PO_${po.order_no || id}_${Date.now()}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.send(pdfBuffer);

  } catch (error) {
    console.error("Error generating PO PDF:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: Upload email attachments for a PO
// POST /api/po/:id/upload-email-attachment
// ─────────────────────────────────────────────────────────────────────────────

const emailAttachmentDir = path.join(__dirname, "../../uploads/po_email_attachments");
if (!fs.existsSync(emailAttachmentDir)) {
  fs.mkdirSync(emailAttachmentDir, { recursive: true });
}

const emailAttachmentStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, emailAttachmentDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const uploadEmailAttachment = multer({ storage: emailAttachmentStorage });

/**
 * @swagger
 * /api/po/{id}/upload-email-attachment:
 *   post:
 *     summary: Upload one or more attachments to be sent with the PO email
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
 */
router.post(
  "/:id/upload-email-attachment",
  uploadEmailAttachment.array("files", 10),
  async (req, res) => {
    const { id } = req.params;
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded." });
    }
    try {
      const attachments = [];
      for (const file of req.files) {
        const filePath = `/uploads/po_email_attachments/${file.filename}`;
        await pool.query(
          `INSERT INTO po_email_attachments
             (po_id, file_path, original_name, mime_type, size_bytes, uploaded_by_user_id, uploaded_by_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, filePath, file.originalname, file.mimetype, file.size, req.body.user_id || null, req.body.user_name || null]
        );
        attachments.push({ filePath, originalName: file.originalname });
      }
      return res.status(200).json({ message: `${attachments.length} file(s) uploaded successfully.`, attachments });
    } catch (error) {
      console.error("Error saving email attachment record:", error);
      res.status(500).json({ error: error.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: Send PO Email
// POST /api/po/:id/send-email
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/po/{id}/send-email:
 *   post:
 *     summary: Send PO details via email
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
 *             type: object
 *             required: [to]
 *             properties:
 *               to: { type: string }
 *               cc: { type: array, items: { type: string } }
 *               message: { type: string }
 *               attachments:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     filePath: { type: string }
 *                     originalName: { type: string }
 *               user_id: { type: string }
 *               user_name: { type: string }
 *     responses:
 *       200: { description: Email sent successfully }
 */
router.post("/:id/send-email", async (req, res) => {
  const { id } = req.params;
  const { to, cc, message, attachments, user_id, user_name } = req.body;

  if (!to) return res.status(400).json({ error: "Recipient email is required." });

  try {
    const result = await pool.query(
      `SELECT po.*, p.project_name 
       FROM pos po 
       LEFT JOIN projects p ON p.project_id = po.project_id
       WHERE po.po_id = $1`, 
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "PO not found" });
    const po = result.rows[0];

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    // Prepare dynamic content for email template
    const infoItems = [
      { label: "Order No", value: po.order_no || id },
      { label: "PO Date", value: formatDate(po.po_date) },
      { label: "Vendor", value: po.vendor_name },
      { label: "Project", value: po.project_name },
      { label: "Site", value: po.site },
      { label: "Contact Person", value: po.contact_person },
      { label: "Indent No", value: po.indent_no },
      { label: "Indent Date", value: formatDate(po.indent_date) },
      { label: "Vendor Address", value: po.vendor_address },
      { label: "Delivery", value: po.delivery },
      { label: "Payment", value: po.payment }
    ].filter(i => i.value);

    const tableHeaders = ["Sr No", "Description", "Qty", "UOM", "Rate", "Amount"];
    
    // items is already a JSONB column in pos table
    const poItems = Array.isArray(po.items) ? po.items : [];

    let totalSection = `
      <div class="total-row">
        <div class="total-label">Subtotal:</div>
        <div class="total-value">${formatCurrency(po.after_discount || 0)}</div>
      </div>
    `;

    if (po.discount_amount > 0) {
      totalSection = `
        <div class="total-row">
          <div class="total-label">Discount:</div>
          <div class="total-value">-${formatCurrency(po.discount_amount)}</div>
        </div>
        ${totalSection}
      `;
    }

    if (po.cgst_amount > 0 || po.sgst_amount > 0) {
      totalSection += `
        <div class="total-row">
          <div class="total-label">CGST (${po.cgst}%):</div>
          <div class="total-value">${formatCurrency(po.cgst_amount)}</div>
        </div>
        <div class="total-row">
          <div class="total-label">SGST (${po.sgst}%):</div>
          <div class="total-value">${formatCurrency(po.sgst_amount)}</div>
        </div>
      `;
    }

    totalSection += `
      <div class="total-row grand-total">
        <div class="total-label">Total Amount:</div>
        <div class="total-value">${formatCurrency(po.total_amount)}</div>
      </div>
    `;

    if (po.notes) {
      totalSection += `
        <div style="margin-top: 20px; padding-top: 15px; border-top: 1px dashed #ddd; font-size: 13px; color: #666;">
          <strong>Notes:</strong><br/>
          ${po.notes}
        </div>
      `;
    }

    const htmlBody = generateEmailTemplate({
      title: `Purchase Order PO #${po.order_no || id}`,
      message: message || "Please find the details of the Purchase Order below and in the attachment.",
      infoItems,
      items: poItems,
      tableHeaders,
      totalSection,
      accentColor: "#4c8ac7"
    });

    const nodemailerAttachments = [];
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        const absolutePath = path.join(__dirname, "../../", att.filePath);
        if (fs.existsSync(absolutePath)) {
          nodemailerAttachments.push({ filename: att.originalName, path: absolutePath });
        }
      }
    }

    const mailOptions = {
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      cc: cc?.join(","),
      subject: `Purchase Order PO #${po.order_no || id}`,
      html: htmlBody,
      attachments: nodemailerAttachments,
    };

    let emailStatus = "sent";
    let emailError = null;
    let nodemailerMsgId = null;

    try {
      const info = await transporter.sendMail(mailOptions);
      nodemailerMsgId = info.messageId;
    } catch (sendErr) {
      emailStatus = "failed";
      emailError = sendErr.message;
    }

    const attachmentPaths = nodemailerAttachments.map(a => path.basename(a.path));
    await pool.query(
      `INSERT INTO po_email_logs (
        po_id, sent_to, cc_addresses, subject, custom_message,
        attachment_names, status, error_message, nodemailer_msg_id,
        sent_by_user_id, sent_by_name
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, to, cc, `Purchase Order PO #${po.order_no || id}`, message || null, attachmentPaths, emailStatus, emailError, nodemailerMsgId, user_id || null, user_name || null]
    );

    logActivity({
      action: emailStatus === "sent" ? "email_sent" : "email_failed",
      entity_type: "po",
      entity_id: id,
      entity_name: `PO #${po.order_no || id}`,
      performed_by: user_id || null,
      performed_by_name: user_name || null,
      meta: { to, status: emailStatus },
    });

    return res.json({ message: "Email processed", status: emailStatus });
  } catch (error) {
    console.error("Error sending PO email:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: Get email logs for a PO
// GET /api/po/:id/email-logs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/po/{id}/email-logs:
 *   get:
 *     summary: Get all email send history for a PO (optionally filtered by user)
 *     tags: [PO]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: user_id
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: List of logs }
 */
router.get("/:id/email-logs", async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.query;
  try {
    let query = "SELECT * FROM po_email_logs WHERE po_id = $1";
    const params = [id];
    if (user_id) {
      query += " AND sent_by_user_id = $2";
      params.push(user_id);
    }
    query += " ORDER BY sent_at DESC";
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching PO logs:", error);
    res.status(500).json({ error: error.message });
  }
});


module.exports = router;