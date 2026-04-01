const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");
const { generateMIRPdf } = require("../utils/mir_pdf");
const { logActivity } = require("./dashboard");
const { recordMovement } = require("./inventory"); // ← stock-out helper

const uploadDir = path.join(__dirname, "../../uploads/mir");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const u = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, u + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: scan MIR items array and run stock-out for any item carrying
// an inventory_id that has NOT already been issued (inventory_issued !== true).
//
// MIR item format (new fields added, all optional):
//   {
//     srno, hsn, description, qty, UOM, Rate, Amount, remark,  ← existing
//     inventory_id,    ← NEW: link to inventories table
//     issued_qty,      ← NEW: qty to deduct (defaults to qty)
//     inventory_issued,← set automatically to true after stock-out
//   }
// ─────────────────────────────────────────────────────────────────────────────
async function processMirInventory(client, {
  items,
  previous_items = [],
  mir_id,
  mir_ref,
  project_id,
  project_name,
  performed_by,
  performed_by_name,
}) {
  if (!Array.isArray(items) || items.length === 0) return;

  const alreadyIssued = new Set(
    previous_items
      .filter(i => i.inventory_id && i.inventory_issued)
      .map(i => Number(i.inventory_id))
  );

  for (const item of items) {
    if (!item.inventory_id) continue;
    if (alreadyIssued.has(Number(item.inventory_id))) continue;

    const qty = Number(item.issued_qty ?? item.qty ?? 0);
    if (qty <= 0) continue;

    const invRes = await client.query(
      "SELECT name, current_quantity FROM inventories WHERE inventory_id=$1 FOR UPDATE",
      [item.inventory_id]
    );
    if (invRes.rows.length === 0)
      throw new Error(`Inventory item ${item.inventory_id} not found`);

    const available = Number(invRes.rows[0].current_quantity) || 0;
    if (available < qty)
      throw new Error(
        `Insufficient stock for "${invRes.rows[0].name}": available ${available}, requested ${qty}`
      );

    await recordMovement(client, {
      inventory_id:      item.inventory_id,
      movement_type:     "out",
      quantity:          qty,
      source_type:       "mir",
      source_id:         mir_id,
      source_ref:        mir_ref,
      project_id,
      project_name,
      notes:             `Consumed by MIR: ${mir_ref || `#${mir_id}`}`,
      performed_by,
      performed_by_name,
    });

    // Mark so re-saves don't double-deduct
    item.inventory_issued = true;
    item.inventory_issued_at = new Date().toISOString();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/mir/upload
// ─────────────────────────────────────────────────────────────────────────────
router.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const filePath = `/uploads/mir/${req.file.filename}`;
  res.json({ filePath });
  if (req.body.user_id) {
    logActivity({
      action: "uploaded", entity_type: "mir_file",
      entity_id: null, entity_name: req.file.originalname,
      performed_by: req.body.user_id, performed_by_name: req.body.user_name || null,
      meta: { filePath },
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/mir
//
// items array now supports inventory_id + issued_qty:
//   {
//     srno: 1, hsn: "...", description: "Tile 60x60", qty: 50, UOM: "sqft",
//     inventory_id: 12,   ← which inventory item to consume
//     issued_qty: 50,     ← qty to deduct (defaults to qty)
//   }
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/mir:
 *   post:
 *     summary: Create a MIR (inventory auto stock-out if inventory_id in items)
 *     tags: [MIR]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               project_name:         { type: string }
 *               project_code:         { type: string }
 *               client_name:          { type: string }
 *               pmc:                  { type: string }
 *               contractor:           { type: string }
 *               vendor_code:          { type: string }
 *               challan_no:           { type: string }
 *               mir_refrence_no:      { type: string }
 *               material_code:        { type: string }
 *               inspection_date_time: { type: string, format: date-time }
 *               client_submission_date: { type: string, format: date }
 *               refrence_docs_attached: { type: string }
 *               mir_submited:         { type: boolean }
 *               dynamic_field:        { type: array }
 *               project_id:           { type: integer }
 *               po_id:                { type: integer }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     srno:         { type: integer }
 *                     hsn:          { type: string }
 *                     description:  { type: string }
 *                     qty:          { type: number }
 *                     UOM:          { type: string }
 *                     Rate:         { type: number }
 *                     Amount:       { type: number }
 *                     remark:       { type: string }
 *                     inventory_id: { type: integer, description: "Link to inventories item" }
 *                     issued_qty:   { type: number,  description: "Qty to deduct (default: qty)" }
 *     responses:
 *       201:
 *         description: MIR created; linked inventory items deducted
 *       400:
 *         description: Insufficient stock or bad data
 */
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const {
      project_name, project_code, client_name, pmc, contractor,
      vendor_code, challan_no, mir_refrence_no, material_code,
      inspection_date_time, client_submission_date,
      refrence_docs_attached, mir_submited, dynamic_field,
      project_id, po_id, items,
    } = req.body;

    const mirItems = items || [];

    const result = await client.query(
      `INSERT INTO mirs (
         project_name, project_code, client_name, pmc, contractor, vendor_code,
         challan_no, mir_refrence_no, material_code, inspection_date_time,
         client_submission_date, refrence_docs_attached, mir_submited,
         dynamic_field, project_id, po_id, items
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        project_name, project_code, client_name, pmc, contractor,
        vendor_code, challan_no, mir_refrence_no, material_code,
        inspection_date_time, client_submission_date,
        refrence_docs_attached, mir_submited,
        JSON.stringify(dynamic_field || []),
        project_id, po_id || null,
        JSON.stringify(mirItems),
      ]
    );

    const mir = result.rows[0];

    // Process stock-outs
    await processMirInventory(client, {
      items:             mirItems,
      mir_id:            mir.mir_id,
      mir_ref:           mir_refrence_no || `MIR #${mir.mir_id}`,
      project_id,
      project_name,
      performed_by:      req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
    });

    // If any items got marked inventory_issued, persist the updated array
    if (mirItems.some(i => i.inventory_issued)) {
      await client.query(
        "UPDATE mirs SET items=$1 WHERE mir_id=$2",
        [JSON.stringify(mirItems), mir.mir_id]
      );
      mir.items = mirItems;
    }

    await client.query("COMMIT");
    res.status(201).json(mir);

    logActivity({
      action: "created", entity_type: "mir",
      entity_id: mir.mir_id,
      entity_name: mir_refrence_no || `MIR #${mir.mir_id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: mir.project_id,
      meta: { mir_refrence_no },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error creating MIR:", error.message);
    if (error.code === "23503")
      return res.status(400).json({ error: "Invalid project_id: Project does not exist" });
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/mir
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/mir:
 *   get:
 *     summary: Get all MIRs
 *     tags: [MIR]
 *     responses:
 *       200:
 *         description: List of all MIRs
 */
router.get("/", async (req, res) => {
  try {
    res.json((await pool.query("SELECT * FROM mirs ORDER BY created_at DESC")).rows);
  } catch (e) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/mir/project/:projectId
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/mir/project/{projectId}:
 *   get:
 *     summary: Get all MIRs for a specific project
 *     tags: [MIR]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: List of MIRs for the project
 */
router.get("/project/:projectId", async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT * FROM mirs WHERE project_id=$1 ORDER BY created_at DESC",
      [req.params.projectId]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/mir/:id
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/mir/{id}:
 *   get:
 *     summary: Get a single MIR by ID
 *     tags: [MIR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: MIR details
 *       404:
 *         description: MIR not found
 */
router.get("/:id", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM mirs WHERE mir_id=$1", [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: "MIR not found" });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/mir/:id
// New inventory_id entries in items trigger stock-outs.
// Previously-issued entries (inventory_issued=true) are skipped.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/mir/{id}:
 *   put:
 *     summary: Update a MIR (new inventory_id items auto stock-out)
 *     tags: [MIR]
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { id } = req.params;
    const {
      project_name, project_code, client_name, pmc, contractor,
      vendor_code, challan_no, mir_refrence_no, material_code,
      inspection_date_time, client_submission_date,
      refrence_docs_attached, mir_submited, dynamic_field, project_id,
      items,
    } = req.body;

    // Fetch existing MIR to get previous items
    const existing = await client.query("SELECT * FROM mirs WHERE mir_id=$1", [id]);
    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "MIR not found" });
    }
    const prevMir = existing.rows[0];
    const prevItems = Array.isArray(prevMir.items) ? prevMir.items : [];

    // Build dynamic UPDATE
    const updateFields = [];
    const values = [];
    let counter = 1;

    if (project_name !== undefined)         { updateFields.push(`project_name=$${counter++}`);         values.push(project_name); }
    if (project_code !== undefined)         { updateFields.push(`project_code=$${counter++}`);         values.push(project_code); }
    if (client_name !== undefined)          { updateFields.push(`client_name=$${counter++}`);          values.push(client_name); }
    if (pmc !== undefined)                  { updateFields.push(`pmc=$${counter++}`);                  values.push(pmc); }
    if (contractor !== undefined)           { updateFields.push(`contractor=$${counter++}`);           values.push(contractor); }
    if (vendor_code !== undefined)          { updateFields.push(`vendor_code=$${counter++}`);          values.push(vendor_code); }
    if (challan_no !== undefined)           { updateFields.push(`challan_no=$${counter++}`);           values.push(challan_no); }
    if (mir_refrence_no !== undefined)      { updateFields.push(`mir_refrence_no=$${counter++}`);      values.push(mir_refrence_no); }
    if (material_code !== undefined)        { updateFields.push(`material_code=$${counter++}`);        values.push(material_code); }
    if (inspection_date_time !== undefined) { updateFields.push(`inspection_date_time=$${counter++}`); values.push(inspection_date_time); }
    if (client_submission_date !== undefined){ updateFields.push(`client_submission_date=$${counter++}`); values.push(client_submission_date); }
    if (refrence_docs_attached !== undefined){ updateFields.push(`refrence_docs_attached=$${counter++}`); values.push(refrence_docs_attached); }
    if (mir_submited !== undefined)         { updateFields.push(`mir_submited=$${counter++}`);         values.push(mir_submited); }
    if (dynamic_field !== undefined)        { updateFields.push(`dynamic_field=$${counter++}`);        values.push(JSON.stringify(dynamic_field)); }
    if (project_id !== undefined)           { updateFields.push(`project_id=$${counter++}`);           values.push(project_id); }

    // Handle items + inventory movements
    const newItems = items !== undefined ? [...items] : null;

    if (newItems) {
      await processMirInventory(client, {
        items:             newItems,
        previous_items:    prevItems,
        mir_id:            Number(id),
        mir_ref:           mir_refrence_no || prevMir.mir_refrence_no || `MIR #${id}`,
        project_id:        project_id || prevMir.project_id,
        project_name:      project_name || prevMir.project_name || null,
        performed_by:      req.body.user_id || null,
        performed_by_name: req.body.user_name || null,
      });
      updateFields.push(`items=$${counter++}`);
      values.push(JSON.stringify(newItems));
    }

    updateFields.push("updated_at=CURRENT_TIMESTAMP");

    if (updateFields.length === 1) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "No fields to update" });
    }

    values.push(id);
    const result = await client.query(
      `UPDATE mirs SET ${updateFields.join(",")} WHERE mir_id=$${counter} RETURNING *`,
      values
    );

    await client.query("COMMIT");
    res.json(result.rows[0]);

    logActivity({
      action: "updated", entity_type: "mir",
      entity_id: id,
      entity_name: result.rows[0].mir_refrence_no || `MIR #${id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: result.rows[0].project_id,
      meta: { updates: req.body },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error updating MIR:", error.message);
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/mir/:id  (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM mirs WHERE mir_id=$1 RETURNING *",
      [req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "MIR not found" });
    res.json({ message: "MIR deleted successfully" });

    logActivity({
      action: "deleted", entity_type: "mir",
      entity_id: req.params.id,
      entity_name: result.rows[0].mir_refrence_no || `MIR #${req.params.id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: result.rows[0].project_id,
      meta: {},
    });
  } catch (error) {
    console.error("Error deleting MIR:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: Generate MIR PDF
// GET /api/mir/:id/pdf
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/mir/{id}/pdf:
 *   get:
 *     summary: Generate and download a PDF for a MIR
 *     tags: [MIR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: PDF file stream
 *         content:
 *           application/pdf:
 *             schema: { type: string, format: binary }
 *       404:
 *         description: MIR not found
 */
router.get("/:id/pdf", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("SELECT * FROM mirs WHERE mir_id = $1", [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "MIR not found" });
    const mir = result.rows[0];

    const pdfBuffer = await generateMIRPdf(mir);
    const filename = `MIR_${mir.mir_refrence_no || id}_${Date.now()}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error("Error generating MIR PDF:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: Upload email attachments for a MIR
// POST /api/mir/:id/upload-email-attachment
// ─────────────────────────────────────────────────────────────────────────────
const emailAttachmentDir = path.join(__dirname, "../../uploads/mir_email_attachments");
if (!fs.existsSync(emailAttachmentDir)) fs.mkdirSync(emailAttachmentDir, { recursive: true });

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
 * /api/mir/{id}/upload-email-attachment:
 *   post:
 *     summary: Upload one or more attachments to be sent with the MIR email
 *     tags: [MIR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               files:
 *                 type: array
 *                 items: { type: string, format: binary }
 *     responses:
 *       200: { description: Files uploaded successfully }
 */
router.post("/:id/upload-email-attachment", uploadEmailAttachment.array("files", 10), async (req, res) => {
  const { id } = req.params;
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No files uploaded." });
  try {
    const attachments = [];
    for (const file of req.files) {
      const filePath = `/uploads/mir_email_attachments/${file.filename}`;
      // Note: Assuming mir_email_attachments table exists, similar to pr_email_attachments
      await pool.query(
        `INSERT INTO mir_email_attachments
           (mir_id, file_path, original_name, mime_type, size_bytes, uploaded_by_user_id, uploaded_by_name)
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
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: Send MIR Email
// POST /api/mir/:id/send-email
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/mir/{id}/send-email:
 *   post:
 *     summary: Send MIR details via email
 *     tags: [MIR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
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
    const result = await pool.query("SELECT * FROM mirs WHERE mir_id = $1", [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "MIR not found" });
    const mir = result.rows[0];

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const htmlBody = `
      <h1>Material Inspection Report MIR #${mir.mir_refrence_no || id}</h1>
      <p>${message || "Please find the attached Material Inspection Report."}</p>
      <p><b>Project:</b> ${mir.project_name}</p>
      <p><b>Inspection Date:</b> ${new Date(mir.inspection_date_time).toLocaleDateString("en-IN")}</p>
    `;

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
      subject: `Material Inspection Report MIR #${mir.mir_refrence_no || id} - ${mir.project_name}`,
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
    // Note: Assuming mir_email_logs table exists
    await pool.query(
      `INSERT INTO mir_email_logs (
        mir_id, sent_to, cc_addresses, subject, custom_message,
        attachment_names, status, error_message, nodemailer_msg_id,
        sent_by_user_id, sent_by_name
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, to, cc, mailOptions.subject, message || null, attachmentPaths, emailStatus, emailError, nodemailerMsgId, user_id || null, user_name || null]
    );

    logActivity({
      action: emailStatus === "sent" ? "email_sent" : "email_failed",
      entity_type: "mir",
      entity_id: id,
      entity_name: `MIR #${mir.mir_refrence_no || id}`,
      performed_by: user_id || null,
      performed_by_name: user_name || null,
      meta: { to, status: emailStatus },
    });

    return res.json({ message: "Email processed", status: emailStatus });
  } catch (error) {
    console.error("Error sending MIR email:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: Get email logs for a MIR
// GET /api/mir/:id/email-logs
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/mir/{id}/email-logs:
 *   get:
 *     summary: Get all email send history for a MIR
 *     tags: [MIR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: List of logs }
 */
router.get("/:id/email-logs", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("SELECT * FROM mir_email_logs WHERE mir_id = $1 ORDER BY sent_at DESC", [id]);
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching MIR email logs:", error);
    res.status(500).json({ error: error.message });
  }
});