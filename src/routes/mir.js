const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");
const { generateMIRPdf } = require("../utils/mir_pdf");
const { logActivity, getEntityHistory, attachCreatedUpdatedBy } = require("./dashboard");
const { recordMovement } = require("./inventory"); // ← stock-out helper

const uploadDir = path.join(__dirname, "../../uploads/mir");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

/**
 * @swagger
 * tags:
 *   name: MIR
 *   description: |
 *     Material Inspection Report management. Every GET (list/by-id/by-project/by-sample)
 *     response also includes created_by/created_by_name/updated_by/updated_by_name
 *     — see the CreatedUpdatedBy schema.
 */

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const u = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, u + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

const referenceDocDir = path.join(__dirname, "../../uploads/mir_reference_docs");
if (!fs.existsSync(referenceDocDir)) fs.mkdirSync(referenceDocDir, { recursive: true });

const referenceDocStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, referenceDocDir),
  filename: (req, file, cb) => {
    const u = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, u + path.extname(file.originalname));
  },
});
const uploadReferenceDoc = multer({ storage: referenceDocStorage });

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
// Template support: Lodha and Hiranandani each store their template-specific
// fields inside one JSONB column (lodha_data / hiranandani_data) rather than
// as a pile of separate table columns. Helpers below build/merge that JSONB
// blob and flatten it back to top-level keys on read, so the API's request
// and response bodies match the original nested shape the frontend sends.
// ─────────────────────────────────────────────────────────────────────────────
const LODHA_KEYS = [
  "request_submission", "contractor_part", "lodha_pmc",
  "template_ref", "template_revision", "template_date",
];

const HIRANANDANI_KEYS = [
  "control_form", "revision", "location", "material_to_inspect", "storage_location",
  "attachments", "notes", "material_rows",
  "mir_raised_by_name", "mir_raised_by_date_signature",
  "received_by_name", "received_by_date_signature",
  "inspection_engineer_comments", "approval_code",
  "checked_by_client_representative", "checked_by_date_signature",
  "issued_by_name", "issued_by_date_signature",
  "close_out",
];

// Pick only the keys the caller actually sent (so a partial PUT doesn't wipe
// fields it didn't mention), merged on top of whatever was already stored.
function mergeTemplateData(existing, body, keys) {
  const patch = {};
  for (const k of keys) if (body[k] !== undefined) patch[k] = body[k];
  return { ...(existing || {}), ...patch };
}

// Spread the template-specific JSONB blob back onto the row so the response
// shape matches the original request body (nested sub-objects stay nested;
// only the blob's own top-level keys get lifted onto the row).
function flattenMir(row) {
  if (!row) return row;
  const { lodha_data, hiranandani_data, ...rest } = row;
  if (row.template_type === "lodha" && lodha_data) return { ...rest, ...lodha_data };
  if (row.template_type === "hiranandani" && hiranandani_data) return { ...rest, ...hiranandani_data };
  return rest;
}

// Behind a reverse proxy, req.protocol/req.get('host') can report the
// internal http://localhost — prefer the forwarded headers when present.
function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host  = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
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
// POST /api/mir/upload-reference-doc
//
// Upload a single reference document and get back the exact
// { file_name, file_url } object shape used in refrence_docs_attached[],
// with file_url as a full absolute URL (protocol + host + path).
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/mir/upload-reference-doc:
 *   post:
 *     summary: Upload a reference doc, get back { file_name, file_url } (file_url is a full URL)
 *     tags: [MIR]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Uploaded — append this object to refrence_docs_attached[]
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 file_name: { type: string, example: "test-certificate.pdf" }
 *                 file_url:  { type: string, example: "https://api.madhuram.enterprises/uploads/mir_reference_docs/1720000000000-123456789.pdf" }
 *       400:
 *         description: No file uploaded
 */
router.post("/upload-reference-doc", uploadReferenceDoc.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const file_url = `${getBaseUrl(req)}/uploads/mir_reference_docs/${req.file.filename}`;
  res.json({ file_name: req.file.originalname, file_url });
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
 *               refrence_docs_attached:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     file_name: { type: string }
 *                     file_url:  { type: string }
 *               mir_submited:         { type: boolean }
 *               dynamic_field:        { type: array }
 *               project_id:           { type: integer }
 *               po_id:                { type: integer }
 *               sample_id:            { type: string, description: "Link this MIR to a sample (samples.sample_id)" }
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
 *                     item_no:      { type: string,  description: "BOQ item number for this line (optional, same as boqs.item_code)" }
 *                     boq_id:       { type: integer, description: "Link to a BOQ item (boqs.boq_id) — informational only, does not deduct BOQ quantity" }
 *                     boq_qty:      { type: number,  description: "Qty being recorded against that BOQ item" }
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
      project_id, po_id, sample_id, items,
    } = req.body;

    const mirItems = items || [];

    const result = await client.query(
      `INSERT INTO mirs (
         project_name, project_code, client_name, pmc, contractor, vendor_code,
         challan_no, mir_refrence_no, material_code, inspection_date_time,
         client_submission_date, refrence_docs_attached, mir_submited,
         dynamic_field, project_id, po_id, items, sample_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        project_name, project_code, client_name, pmc, contractor,
        vendor_code, challan_no, mir_refrence_no, material_code,
        inspection_date_time, client_submission_date,
        JSON.stringify(refrence_docs_attached || []), mir_submited,
        JSON.stringify(dynamic_field || []),
        project_id, po_id || null,
        JSON.stringify(mirItems),
        sample_id || null,
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
// POST /api/mir/lodha  — create a Lodha-template MIR
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/mir/lodha:
 *   post:
 *     summary: Create a Lodha-template MIR
 *     tags: [MIR]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [project_id]
 *             properties:
 *               project_name:         { type: string }
 *               project_code:         { type: string }
 *               client_name:          { type: string }
 *               pmc:                  { type: string }
 *               contractor:           { type: string }
 *               vendor_code:          { type: string }
 *               po_id:                { type: integer }
 *               challan_no:           { type: string }
 *               mir_refrence_no:      { type: string }
 *               material_code:        { type: string }
 *               inspection_date_time: { type: string, format: date-time }
 *               client_submission_date: { type: string, format: date }
 *               refrence_docs_attached:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     file_name: { type: string }
 *                     file_url:  { type: string }
 *               project_id:           { type: integer }
 *               sample_id:            { type: string, description: "Link this MIR to a sample (samples.sample_id)" }
 *               mir_submited:         { type: boolean }
 *               request_submission:
 *                 type: object
 *                 properties:
 *                   submitted_to: { type: string }
 *                   discipline:   { type: array, items: { type: string } }
 *               contractor_part:
 *                 type: object
 *                 properties:
 *                   material_submittal_approved:  { type: string }
 *                   approval_ref_no:               { type: string }
 *                   previous_qty:                  { type: string }
 *                   current_qty:                   { type: string }
 *                   cumulative_qty:                { type: string }
 *                   boq_reference:                 { type: string }
 *                   manufacturer_country:          { type: string }
 *                   supplier:                       { type: string }
 *                   delivery_note_number:           { type: string }
 *                   receipt_date:                   { type: string }
 *                   storage_location:               { type: string }
 *                   test_certificate_delivered:     { type: string }
 *                   field_test_compliance_note:     { type: string }
 *                   third_party_test_contractor_compliance_note: { type: string }
 *                   third_party_test_lodha_compliance_note:      { type: string }
 *                   contractor_name:                { type: string }
 *                   contractor_signature:           { type: string }
 *                   contractor_date:                { type: string }
 *               lodha_pmc:
 *                 type: object
 *                 properties:
 *                   inspection_reports:
 *                     type: object
 *                     properties:
 *                       physical_damage:            { type: string }
 *                       delivery_note_correct:      { type: string }
 *                       conform_approved_submittal: { type: string }
 *                       mtc_delivered:               { type: string }
 *                       field_test_compliance:       { type: string }
 *                       third_party_contractor_scope: { type: string }
 *                       third_party_lodha_scope:      { type: string }
 *                   sign_offs:
 *                     type: object
 *                     properties:
 *                       civil_project_manager: { type: string }
 *                       civil_quality_manager: { type: string }
 *                       facade_manager:        { type: string }
 *                       landscape_architect:   { type: string }
 *                       mep_manager:           { type: string }
 *                   comments:      { type: string }
 *                   result_code:   { type: string }
 *                   result_name:   { type: string }
 *                   result_signature: { type: string }
 *                   result_date:   { type: string }
 *                   distribution:
 *                     type: object
 *                     properties:
 *                       lodha:      { type: boolean }
 *                       contractor: { type: boolean }
 *                       others:     { type: string }
 *               template_ref:      { type: string }
 *               template_revision: { type: string }
 *               template_date:     { type: string }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     srno:           { type: integer }
 *                     hsn:            { type: string }
 *                     item_code:      { type: string }
 *                     description:    { type: string }
 *                     name:           { type: string }
 *                     qty:            { type: number }
 *                     uom:            { type: string }
 *                     rate:           { type: number }
 *                     amount:         { type: number }
 *                     remark:         { type: string }
 *                     inspected:      { type: boolean }
 *                     include_in_mir: { type: boolean }
 *                     inventory_id:   { type: integer, description: "Link to inventories item" }
 *                     issued_qty:     { type: number,  description: "Qty to deduct (default: qty)" }
 *                     item_no:        { type: string,  description: "BOQ item number for this line (optional, same as boqs.item_code)" }
 *                     boq_id:         { type: integer, description: "Link to a BOQ item (boqs.boq_id) — informational only, does not deduct BOQ quantity" }
 *                     boq_qty:        { type: number,  description: "Qty being recorded against that BOQ item" }
 *           example:
 *             project_name: ""
 *             project_code: ""
 *             client_name: ""
 *             pmc: ""
 *             contractor: ""
 *             vendor_code: ""
 *             po_id: 1
 *             challan_no: ""
 *             mir_refrence_no: ""
 *             material_code: ""
 *             inspection_date_time: "2026-07-08T00:00:00.000Z"
 *             client_submission_date: "2026-07-08"
 *             refrence_docs_attached:
 *               - file_name: ""
 *                 file_url: ""
 *             project_id: 1
 *             mir_submited: true
 *             request_submission:
 *               submitted_to: ""
 *               discipline: []
 *             contractor_part:
 *               material_submittal_approved: ""
 *               approval_ref_no: ""
 *               previous_qty: ""
 *               current_qty: ""
 *               cumulative_qty: ""
 *               boq_reference: ""
 *               manufacturer_country: ""
 *               supplier: ""
 *               delivery_note_number: ""
 *               receipt_date: ""
 *               storage_location: ""
 *               test_certificate_delivered: ""
 *               field_test_compliance_note: ""
 *               third_party_test_contractor_compliance_note: ""
 *               third_party_test_lodha_compliance_note: ""
 *               contractor_name: ""
 *               contractor_signature: ""
 *               contractor_date: ""
 *             lodha_pmc:
 *               inspection_reports:
 *                 physical_damage: ""
 *                 delivery_note_correct: ""
 *                 conform_approved_submittal: ""
 *                 mtc_delivered: ""
 *                 field_test_compliance: ""
 *                 third_party_contractor_scope: ""
 *                 third_party_lodha_scope: ""
 *               sign_offs:
 *                 civil_project_manager: ""
 *                 civil_quality_manager: ""
 *                 facade_manager: ""
 *                 landscape_architect: ""
 *                 mep_manager: ""
 *               comments: ""
 *               result_code: ""
 *               result_name: ""
 *               result_signature: ""
 *               result_date: ""
 *               distribution:
 *                 lodha: false
 *                 contractor: false
 *                 others: ""
 *             template_ref: ""
 *             template_revision: ""
 *             template_date: ""
 *             items:
 *               - srno: 1
 *                 hsn: ""
 *                 item_code: ""
 *                 item_no: ""
 *                 description: ""
 *                 name: ""
 *                 qty: 0
 *                 uom: ""
 *                 rate: 0
 *                 amount: 0
 *                 remark: ""
 *                 inspected: false
 *                 include_in_mir: true
 *                 boq_id: 0
 *                 boq_qty: 0
 *     responses:
 *       201:
 *         description: Lodha MIR created
 *       400:
 *         description: Insufficient stock or bad data
 */
router.post("/lodha", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const {
      project_name, project_code, client_name, pmc, contractor, vendor_code,
      po_id, challan_no, mir_refrence_no, material_code,
      inspection_date_time, client_submission_date, refrence_docs_attached,
      project_id, mir_submited, sample_id, items,
    } = req.body;

    const mirItems  = items || [];
    const lodhaData = mergeTemplateData({}, req.body, LODHA_KEYS);

    const result = await client.query(
      `INSERT INTO mirs (
         project_name, project_code, client_name, pmc, contractor, vendor_code,
         po_id, challan_no, mir_refrence_no, material_code,
         inspection_date_time, client_submission_date, refrence_docs_attached,
         project_id, template_type, mir_submited, lodha_data, items, sample_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'lodha',$15,$16,$17,$18)
       RETURNING *`,
      [
        project_name, project_code, client_name, pmc, contractor, vendor_code,
        po_id || null, challan_no, mir_refrence_no, material_code,
        inspection_date_time, client_submission_date,
        JSON.stringify(refrence_docs_attached || []),
        project_id, mir_submited ?? false,
        JSON.stringify(lodhaData),
        JSON.stringify(mirItems),
        sample_id || null,
      ]
    );

    const mir = result.rows[0];

    await processMirInventory(client, {
      items:             mirItems,
      mir_id:            mir.mir_id,
      mir_ref:           mir_refrence_no || `MIR #${mir.mir_id}`,
      project_id,
      project_name,
      performed_by:      req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
    });

    if (mirItems.some(i => i.inventory_issued)) {
      await client.query("UPDATE mirs SET items=$1 WHERE mir_id=$2", [JSON.stringify(mirItems), mir.mir_id]);
      mir.items = mirItems;
    }

    await client.query("COMMIT");
    res.status(201).json(flattenMir(mir));

    logActivity({
      action: "created", entity_type: "mir",
      entity_id: mir.mir_id,
      entity_name: mir_refrence_no || `MIR #${mir.mir_id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: mir.project_id,
      meta: { mir_refrence_no, template_type: "lodha" },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error creating Lodha MIR:", error.message);
    if (error.code === "23503")
      return res.status(400).json({ error: "Invalid project_id: Project does not exist" });
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/mir/hiranandani  — create a Hiranandani-template MIR
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/mir/hiranandani:
 *   post:
 *     summary: Create a Hiranandani-template MIR
 *     tags: [MIR]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [project_id]
 *             properties:
 *               project_name:         { type: string }
 *               project_code:         { type: string }
 *               client_name:          { type: string }
 *               pmc:                  { type: string }
 *               contractor:           { type: string }
 *               vendor_code:          { type: string }
 *               po_id:                { type: integer }
 *               challan_no:           { type: string }
 *               mir_refrence_no:      { type: string }
 *               material_code:        { type: string }
 *               inspection_date_time: { type: string, format: date-time }
 *               client_submission_date: { type: string, format: date }
 *               refrence_docs_attached:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     file_name: { type: string }
 *                     file_url:  { type: string }
 *               project_id:           { type: integer }
 *               sample_id:            { type: string, description: "Link this MIR to a sample (samples.sample_id)" }
 *               mir_submited:         { type: boolean }
 *               control_form:         { type: string }
 *               revision:             { type: string }
 *               location:             { type: string }
 *               material_to_inspect:  { type: string }
 *               storage_location:     { type: string }
 *               attachments:          { type: string }
 *               notes:
 *                 type: object
 *                 properties:
 *                   manufacturer:            { type: string }
 *                   purchase_order_no:       { type: string }
 *                   manufacturer_date:       { type: string }
 *                   challan_invoice_no:      { type: string }
 *                   expiry_date:             { type: string }
 *                   delivery_date:           { type: string }
 *                   batch_no:                { type: string }
 *                   material_submittal_ref:  { type: string }
 *                   source_country:          { type: string }
 *                   specification_ref:       { type: string }
 *                   quantity_delivered:      { type: string }
 *                   drawings_ref:            { type: string }
 *               material_rows:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     material: { type: string }
 *                     size:     { type: string }
 *                     quantity: { type: string }
 *                     unit:     { type: string }
 *               mir_raised_by_name:               { type: string }
 *               mir_raised_by_date_signature:     { type: string }
 *               received_by_name:                 { type: string }
 *               received_by_date_signature:       { type: string }
 *               inspection_engineer_comments:     { type: string }
 *               approval_code:                    { type: string }
 *               checked_by_client_representative: { type: string }
 *               checked_by_date_signature:        { type: string }
 *               issued_by_name:                   { type: string }
 *               issued_by_date_signature:         { type: string }
 *               close_out:
 *                 type: object
 *                 properties:
 *                   action_taken:    { type: string }
 *                   checked_by:      { type: string }
 *                   status:          { type: string }
 *                   date_signature:  { type: string }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     srno:           { type: integer }
 *                     hsn:            { type: string }
 *                     item_code:      { type: string }
 *                     description:    { type: string }
 *                     name:           { type: string }
 *                     qty:            { type: number }
 *                     uom:            { type: string }
 *                     rate:           { type: number }
 *                     amount:         { type: number }
 *                     remark:         { type: string }
 *                     inspected:      { type: boolean }
 *                     include_in_mir: { type: boolean }
 *                     inventory_id:   { type: integer, description: "Link to inventories item" }
 *                     issued_qty:     { type: number,  description: "Qty to deduct (default: qty)" }
 *                     item_no:        { type: string,  description: "BOQ item number for this line (optional, same as boqs.item_code)" }
 *                     boq_id:         { type: integer, description: "Link to a BOQ item (boqs.boq_id) — informational only, does not deduct BOQ quantity" }
 *                     boq_qty:        { type: number,  description: "Qty being recorded against that BOQ item" }
 *           example:
 *             project_name: ""
 *             project_code: ""
 *             client_name: ""
 *             pmc: ""
 *             contractor: ""
 *             vendor_code: ""
 *             po_id: 1
 *             challan_no: ""
 *             mir_refrence_no: ""
 *             material_code: ""
 *             inspection_date_time: "2026-07-08T00:00:00.000Z"
 *             client_submission_date: "2026-07-08"
 *             refrence_docs_attached:
 *               - file_name: ""
 *                 file_url: ""
 *             project_id: 1
 *             mir_submited: true
 *             control_form: ""
 *             revision: ""
 *             location: ""
 *             material_to_inspect: ""
 *             storage_location: ""
 *             attachments: ""
 *             notes:
 *               manufacturer: ""
 *               purchase_order_no: ""
 *               manufacturer_date: ""
 *               challan_invoice_no: ""
 *               expiry_date: ""
 *               delivery_date: ""
 *               batch_no: ""
 *               material_submittal_ref: ""
 *               source_country: ""
 *               specification_ref: ""
 *               quantity_delivered: ""
 *               drawings_ref: ""
 *             material_rows:
 *               - material: ""
 *                 size: ""
 *                 quantity: ""
 *                 unit: ""
 *             mir_raised_by_name: ""
 *             mir_raised_by_date_signature: ""
 *             received_by_name: ""
 *             received_by_date_signature: ""
 *             inspection_engineer_comments: ""
 *             approval_code: ""
 *             checked_by_client_representative: ""
 *             checked_by_date_signature: ""
 *             issued_by_name: ""
 *             issued_by_date_signature: ""
 *             close_out:
 *               action_taken: ""
 *               checked_by: ""
 *               status: ""
 *               date_signature: ""
 *             items:
 *               - srno: 1
 *                 hsn: ""
 *                 item_code: ""
 *                 item_no: ""
 *                 description: ""
 *                 name: ""
 *                 qty: 0
 *                 uom: ""
 *                 rate: 0
 *                 amount: 0
 *                 remark: ""
 *                 inspected: false
 *                 include_in_mir: true
 *                 boq_id: 0
 *                 boq_qty: 0
 *     responses:
 *       201:
 *         description: Hiranandani MIR created
 *       400:
 *         description: Insufficient stock or bad data
 */
router.post("/hiranandani", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const {
      project_name, project_code, client_name, pmc, contractor, vendor_code,
      po_id, challan_no, mir_refrence_no, material_code,
      inspection_date_time, client_submission_date, refrence_docs_attached,
      project_id, mir_submited, sample_id, items,
    } = req.body;

    const mirItems        = items || [];
    const hiranandaniData = mergeTemplateData({}, req.body, HIRANANDANI_KEYS);

    const result = await client.query(
      `INSERT INTO mirs (
         project_name, project_code, client_name, pmc, contractor, vendor_code,
         po_id, challan_no, mir_refrence_no, material_code,
         inspection_date_time, client_submission_date, refrence_docs_attached,
         project_id, template_type, mir_submited, hiranandani_data, items, sample_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'hiranandani',$15,$16,$17,$18)
       RETURNING *`,
      [
        project_name, project_code, client_name, pmc, contractor, vendor_code,
        po_id || null, challan_no, mir_refrence_no, material_code,
        inspection_date_time, client_submission_date,
        JSON.stringify(refrence_docs_attached || []),
        project_id, mir_submited ?? false,
        JSON.stringify(hiranandaniData),
        JSON.stringify(mirItems),
        sample_id || null,
      ]
    );

    const mir = result.rows[0];

    await processMirInventory(client, {
      items:             mirItems,
      mir_id:            mir.mir_id,
      mir_ref:           mir_refrence_no || `MIR #${mir.mir_id}`,
      project_id,
      project_name,
      performed_by:      req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
    });

    if (mirItems.some(i => i.inventory_issued)) {
      await client.query("UPDATE mirs SET items=$1 WHERE mir_id=$2", [JSON.stringify(mirItems), mir.mir_id]);
      mir.items = mirItems;
    }

    await client.query("COMMIT");
    res.status(201).json(flattenMir(mir));

    logActivity({
      action: "created", entity_type: "mir",
      entity_id: mir.mir_id,
      entity_name: mir_refrence_no || `MIR #${mir.mir_id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: mir.project_id,
      meta: { mir_refrence_no, template_type: "hiranandani" },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error creating Hiranandani MIR:", error.message);
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
 *     description: |
 *       Lodha rows have their lodha_data blob flattened back to top-level keys
 *       (request_submission, contractor_part, lodha_pmc, template_ref, ...).
 *       Hiranandani rows have their hiranandani_data blob flattened the same way
 *       (control_form, notes, material_rows, close_out, ...).
 *     tags: [MIR]
 *     responses:
 *       200:
 *         description: List of all MIRs
 */
router.get("/", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM mirs ORDER BY created_at DESC");
    res.json(await attachCreatedUpdatedBy(r.rows.map(flattenMir), "mir", (row) => row.mir_id));
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
 *     description: Same flattening as GET /api/mir — template-specific fields appear at the top level based on template_type.
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
    res.json(await attachCreatedUpdatedBy(r.rows.map(flattenMir), "mir", (row) => row.mir_id));
  } catch (e) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/mir/sample/:sampleId
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/mir/sample/{sampleId}:
 *   get:
 *     summary: Get all MIRs linked to a specific sample
 *     description: Same flattening as GET /api/mir — template-specific fields appear at the top level based on template_type.
 *     tags: [MIR]
 *     parameters:
 *       - in: path
 *         name: sampleId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of MIRs for the sample
 */
router.get("/sample/:sampleId", async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT * FROM mirs WHERE sample_id=$1 ORDER BY created_at DESC",
      [req.params.sampleId]
    );
    res.json(await attachCreatedUpdatedBy(r.rows.map(flattenMir), "mir", (row) => row.mir_id));
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
 *     description: Response is flattened back to the original template request-body shape (see POST /api/mir/lodha or POST /api/mir/hiranandani), based on this MIR's template_type.
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
    res.json(await attachCreatedUpdatedBy(flattenMir(r.rows[0]), "mir", (row) => row.mir_id));
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
      sample_id, items,
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
    if (refrence_docs_attached !== undefined){ updateFields.push(`refrence_docs_attached=$${counter++}`); values.push(JSON.stringify(refrence_docs_attached)); }
    if (mir_submited !== undefined)         { updateFields.push(`mir_submited=$${counter++}`);         values.push(mir_submited); }
    if (dynamic_field !== undefined)        { updateFields.push(`dynamic_field=$${counter++}`);        values.push(JSON.stringify(dynamic_field)); }
    if (project_id !== undefined)           { updateFields.push(`project_id=$${counter++}`);           values.push(project_id); }
    if (sample_id !== undefined)            { updateFields.push(`sample_id=$${counter++}`);            values.push(sample_id || null); }

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
    res.json(flattenMir(result.rows[0]));

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
// PUT /api/mir/lodha/:id  — edit a Lodha-template MIR
// Only fields present in the body are changed (partial update); lodha_data
// sub-fields (request_submission, contractor_part, lodha_pmc, template_ref,
// template_revision, template_date) are merged onto what's already stored.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/mir/lodha/{id}:
 *   put:
 *     summary: Update a Lodha-template MIR (partial update)
 *     tags: [MIR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             description: Same shape as POST /api/mir/lodha — send only the fields you want to change.
 *             type: object
 *     responses:
 *       200:
 *         description: Updated Lodha MIR
 *       400:
 *         description: This MIR is not a Lodha template, or no fields to update
 *       404:
 *         description: MIR not found
 */
router.put("/lodha/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { id } = req.params;
    const {
      project_name, project_code, client_name, pmc, contractor, vendor_code,
      po_id, challan_no, mir_refrence_no, material_code,
      inspection_date_time, client_submission_date,
      refrence_docs_attached, mir_submited, project_id, sample_id, items,
    } = req.body;

    const existing = await client.query("SELECT * FROM mirs WHERE mir_id=$1", [id]);
    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "MIR not found" });
    }
    const prevMir = existing.rows[0];
    if (prevMir.template_type && prevMir.template_type !== "lodha") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: `This MIR is a "${prevMir.template_type}" template — use PUT /api/mir/${prevMir.template_type}/:id` });
    }
    const prevItems = Array.isArray(prevMir.items) ? prevMir.items : [];

    const updateFields = [];
    const values = [];
    let counter = 1;

    if (project_name !== undefined)          { updateFields.push(`project_name=$${counter++}`);          values.push(project_name); }
    if (project_code !== undefined)          { updateFields.push(`project_code=$${counter++}`);          values.push(project_code); }
    if (client_name !== undefined)           { updateFields.push(`client_name=$${counter++}`);           values.push(client_name); }
    if (pmc !== undefined)                   { updateFields.push(`pmc=$${counter++}`);                   values.push(pmc); }
    if (contractor !== undefined)            { updateFields.push(`contractor=$${counter++}`);            values.push(contractor); }
    if (vendor_code !== undefined)           { updateFields.push(`vendor_code=$${counter++}`);           values.push(vendor_code); }
    if (po_id !== undefined)                 { updateFields.push(`po_id=$${counter++}`);                 values.push(po_id); }
    if (challan_no !== undefined)            { updateFields.push(`challan_no=$${counter++}`);            values.push(challan_no); }
    if (mir_refrence_no !== undefined)       { updateFields.push(`mir_refrence_no=$${counter++}`);       values.push(mir_refrence_no); }
    if (material_code !== undefined)         { updateFields.push(`material_code=$${counter++}`);         values.push(material_code); }
    if (inspection_date_time !== undefined)  { updateFields.push(`inspection_date_time=$${counter++}`);  values.push(inspection_date_time); }
    if (client_submission_date !== undefined){ updateFields.push(`client_submission_date=$${counter++}`); values.push(client_submission_date); }
    if (refrence_docs_attached !== undefined){ updateFields.push(`refrence_docs_attached=$${counter++}`); values.push(JSON.stringify(refrence_docs_attached)); }
    if (mir_submited !== undefined)          { updateFields.push(`mir_submited=$${counter++}`);          values.push(mir_submited); }
    if (project_id !== undefined)            { updateFields.push(`project_id=$${counter++}`);            values.push(project_id); }
    if (sample_id !== undefined)             { updateFields.push(`sample_id=$${counter++}`);             values.push(sample_id || null); }

    updateFields.push(`template_type=$${counter++}`);
    values.push("lodha");

    const mergedLodhaData = mergeTemplateData(prevMir.lodha_data, req.body, LODHA_KEYS);
    updateFields.push(`lodha_data=$${counter++}`);
    values.push(JSON.stringify(mergedLodhaData));

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

    values.push(id);
    const result = await client.query(
      `UPDATE mirs SET ${updateFields.join(",")} WHERE mir_id=$${counter} RETURNING *`,
      values
    );

    await client.query("COMMIT");
    res.json(flattenMir(result.rows[0]));

    logActivity({
      action: "updated", entity_type: "mir",
      entity_id: id,
      entity_name: result.rows[0].mir_refrence_no || `MIR #${id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: result.rows[0].project_id,
      meta: { updates: req.body, template_type: "lodha" },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error updating Lodha MIR:", error.message);
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/mir/hiranandani/:id  — edit a Hiranandani-template MIR
// Only fields present in the body are changed (partial update); hiranandani_data
// sub-fields are merged onto what's already stored.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/mir/hiranandani/{id}:
 *   put:
 *     summary: Update a Hiranandani-template MIR (partial update)
 *     tags: [MIR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             description: Same shape as POST /api/mir/hiranandani — send only the fields you want to change.
 *             type: object
 *     responses:
 *       200:
 *         description: Updated Hiranandani MIR
 *       400:
 *         description: This MIR is not a Hiranandani template, or no fields to update
 *       404:
 *         description: MIR not found
 */
router.put("/hiranandani/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { id } = req.params;
    const {
      project_name, project_code, client_name, pmc, contractor, vendor_code,
      po_id, challan_no, mir_refrence_no, material_code,
      inspection_date_time, client_submission_date,
      refrence_docs_attached, mir_submited, project_id, sample_id, items,
    } = req.body;

    const existing = await client.query("SELECT * FROM mirs WHERE mir_id=$1", [id]);
    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "MIR not found" });
    }
    const prevMir = existing.rows[0];
    if (prevMir.template_type && prevMir.template_type !== "hiranandani") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: `This MIR is a "${prevMir.template_type}" template — use PUT /api/mir/${prevMir.template_type}/:id` });
    }
    const prevItems = Array.isArray(prevMir.items) ? prevMir.items : [];

    const updateFields = [];
    const values = [];
    let counter = 1;

    if (project_name !== undefined)          { updateFields.push(`project_name=$${counter++}`);          values.push(project_name); }
    if (project_code !== undefined)          { updateFields.push(`project_code=$${counter++}`);          values.push(project_code); }
    if (client_name !== undefined)           { updateFields.push(`client_name=$${counter++}`);           values.push(client_name); }
    if (pmc !== undefined)                   { updateFields.push(`pmc=$${counter++}`);                   values.push(pmc); }
    if (contractor !== undefined)            { updateFields.push(`contractor=$${counter++}`);            values.push(contractor); }
    if (vendor_code !== undefined)           { updateFields.push(`vendor_code=$${counter++}`);           values.push(vendor_code); }
    if (po_id !== undefined)                 { updateFields.push(`po_id=$${counter++}`);                 values.push(po_id); }
    if (challan_no !== undefined)            { updateFields.push(`challan_no=$${counter++}`);            values.push(challan_no); }
    if (mir_refrence_no !== undefined)       { updateFields.push(`mir_refrence_no=$${counter++}`);       values.push(mir_refrence_no); }
    if (material_code !== undefined)         { updateFields.push(`material_code=$${counter++}`);         values.push(material_code); }
    if (inspection_date_time !== undefined)  { updateFields.push(`inspection_date_time=$${counter++}`);  values.push(inspection_date_time); }
    if (client_submission_date !== undefined){ updateFields.push(`client_submission_date=$${counter++}`); values.push(client_submission_date); }
    if (refrence_docs_attached !== undefined){ updateFields.push(`refrence_docs_attached=$${counter++}`); values.push(JSON.stringify(refrence_docs_attached)); }
    if (mir_submited !== undefined)          { updateFields.push(`mir_submited=$${counter++}`);          values.push(mir_submited); }
    if (project_id !== undefined)            { updateFields.push(`project_id=$${counter++}`);            values.push(project_id); }
    if (sample_id !== undefined)             { updateFields.push(`sample_id=$${counter++}`);             values.push(sample_id || null); }

    updateFields.push(`template_type=$${counter++}`);
    values.push("hiranandani");

    const mergedHiranandaniData = mergeTemplateData(prevMir.hiranandani_data, req.body, HIRANANDANI_KEYS);
    updateFields.push(`hiranandani_data=$${counter++}`);
    values.push(JSON.stringify(mergedHiranandaniData));

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

    values.push(id);
    const result = await client.query(
      `UPDATE mirs SET ${updateFields.join(",")} WHERE mir_id=$${counter} RETURNING *`,
      values
    );

    await client.query("COMMIT");
    res.json(flattenMir(result.rows[0]));

    logActivity({
      action: "updated", entity_type: "mir",
      entity_id: id,
      entity_name: result.rows[0].mir_refrence_no || `MIR #${id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: result.rows[0].project_id,
      meta: { updates: req.body, template_type: "hiranandani" },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error updating Hiranandani MIR:", error.message);
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/mir/:id/toggle-submitted  — flip mir_submited true <-> false
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/mir/{id}/toggle-submitted:
 *   patch:
 *     summary: Toggle a MIR's submitted status (true -> false, false -> true)
 *     tags: [MIR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               user_id:   { type: string, description: "Who performed this action" }
 *               user_name: { type: string }
 *     responses:
 *       200:
 *         description: MIR with the flipped mir_submited value
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 mir_id:       { type: integer, example: 1 }
 *                 mir_submited: { type: boolean, example: true }
 *       404:
 *         description: MIR not found
 */
router.patch("/:id/toggle-submitted", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE mirs
          SET mir_submited = NOT COALESCE(mir_submited, FALSE),
              updated_at   = CURRENT_TIMESTAMP
        WHERE mir_id = $1
        RETURNING *`,
      [id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "MIR not found" });

    const mir = result.rows[0];
    res.json(mir);

    logActivity({
      action: mir.mir_submited ? "submitted" : "unsubmitted",
      entity_type: "mir",
      entity_id: id,
      entity_name: mir.mir_refrence_no || `MIR #${id}`,
      performed_by: req.body?.user_id || null,
      performed_by_name: req.body?.user_name || null,
      project_id: mir.project_id,
      meta: { mir_submited: mir.mir_submited },
    });
  } catch (error) {
    console.error("Error toggling MIR submitted status:", error);
    res.status(500).json({ error: "Internal Server Error" });
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/mir/:id/history — who created/updated/deleted this MIR, and when
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/mir/{id}/history:
 *   get:
 *     summary: Get the create/update/delete history for a MIR (who did what, and when)
 *     tags: [MIR]
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
 *         description: Activity history for this MIR
 */
router.get("/:id/history", async (req, res) => {
  try {
    const data = await getEntityHistory("mir", req.params.id, {
      limit: req.query.limit, offset: req.query.offset,
    });
    res.json(data);
  } catch (error) {
    console.error("Error fetching MIR history:", error);
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