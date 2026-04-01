const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const { logActivity } = require("./dashboard");

// ─── Upload directories ───────────────────────────────────────────────────────
const uploadDir  = path.join(__dirname, "../../uploads/quotations");
const boqDir     = path.join(__dirname, "../../uploads/quotations/boq");
const drawingDir = path.join(__dirname, "../../uploads/quotations/drawings");

[uploadDir, boqDir, drawingDir].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── Multer: Excel only (for /import/excel) ───────────────────────────────────
const excelStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => {
    cb(null, Date.now() + "-" + Math.round(Math.random() * 1e9) + path.extname(file.originalname));
  },
});
const uploadExcel = multer({
  storage: excelStorage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".xls", ".xlsx"].includes(ext)) return cb(null, true);
    cb(new Error("Only .xls and .xlsx files are allowed"));
  },
});

// ─── Multer: BOQ file (any type) ──────────────────────────────────────────────
const uploadBOQ = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, boqDir),
    filename:    (req, file, cb) => {
      cb(null, Date.now() + "-" + Math.round(Math.random() * 1e9) + path.extname(file.originalname));
    },
  }),
});

// ─── Multer: Drawings (multiple files, any type) ──────────────────────────────
const uploadDrawings = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, drawingDir),
    filename:    (req, file, cb) => {
      cb(null, Date.now() + "-" + Math.round(Math.random() * 1e9) + path.extname(file.originalname));
    },
  }),
});

// ─── Multer: Standalone BOQ/Drawing upload ────────────────────────────────────
const standaloneUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dest = file.fieldname === 'boq' ? boqDir : drawingDir;
      cb(null, dest);
    },
    filename: (req, file, cb) => {
      cb(null, Date.now() + "-" + Math.round(Math.random() * 1e9) + path.extname(file.originalname));
    },
  }),
});

// ─── Helper: parse BOQ Excel ──────────────────────────────────────────────────
function parseBOQExcel(filePath) {
  const workbook = XLSX.readFile(filePath);

  const sheetName =
    workbook.SheetNames.find((n) => n.toLowerCase().includes("boq")) ||
    workbook.SheetNames[0];
  const ws  = workbook.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  // Find header row (the row that has "Description" in it)
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(raw.length, 20); i++) {
    if (
      raw[i] &&
      raw[i].some(
        (cell) => cell && typeof cell === "string" && cell.toLowerCase().includes("description")
      )
    ) {
      headerRowIdx = i;
      break;
    }
  }

  const items = [];
  const dataStartRow = headerRowIdx + 2; // skip header row + blank row below it

  for (let i = dataStartRow; i < raw.length; i++) {
    const row = raw[i];
    if (!row) continue;

    const itemNo      = row[1];
    const description = row[2];

    if (!itemNo || !description) continue;
    // Skip section headers like "A.", "B."
    if (typeof itemNo === "string" && /^[A-Z]\.?$/.test(String(itemNo).trim())) continue;
    // Skip subtotal rows
    if (typeof description === "string" && description.toUpperCase().includes("TOTAL")) continue;

    items.push({
      item_no:                    String(itemNo).trim(),
      description:                String(description).trim(),
      unit:                       row[3]  != null ? String(row[3]).trim() : null,
      quantity:                   row[4]  != null ? Number(row[4])        : null,
      rate:                       row[5]  != null ? Number(row[5])        : null,
      amount:                     row[6]  != null ? Number(row[6])        : null,
      basic_rate:                 row[7]  != null ? Number(row[7])        : null,
      discount:                   row[8]  != null ? Number(row[8])        : null,
      final_rate_after_discount:  row[9]  != null ? Number(row[9])        : null,
      fittings:                   row[10] != null ? Number(row[10])       : null,
      transportation:             row[11] != null ? Number(row[11])       : null,
      support:                    row[12] != null ? Number(row[12])       : null,
      miscellaneous:              row[14] != null ? Number(row[14])       : null,
      total_material_price:       row[15] != null ? Number(row[15])       : null,
      labour:                     row[16] != null ? Number(row[16])       : null,
      material_plus_labour:       row[17] != null ? Number(row[17])       : null,
      profit:                     row[18] != null ? Number(row[18])       : null,
      total_rate:                 row[19] != null ? Number(row[19])       : null,
    });
  }

  // Parse Grand Summary sheet for totals
  const summarySheetName = workbook.SheetNames.find(
    (n) => n.toLowerCase().includes("summary") || n.toLowerCase().includes("grand")
  ) || null;

  let summary = {};
  if (summarySheetName) {
    const sraw = XLSX.utils.sheet_to_json(workbook.Sheets[summarySheetName], {
      header: 1,
      defval: null,
    });
    for (const row of sraw) {
      if (!row) continue;
      const flat = row.filter((c) => c != null).join(" ").trim();
      if (/TOTAL AMOUNT/i.test(flat) && !summary.total_amount) {
        const num = row.find((c) => typeof c === "number" && c > 0);
        if (num) summary.total_amount = num;
      }
      if (/GST/i.test(flat)) {
        const num = row.find((c) => typeof c === "number" && c > 0);
        if (num) summary.gst_amount = num;
      }
      if (/GRAND TOTAL/i.test(flat)) {
        const num = row.find((c) => typeof c === "number" && c > 0);
        if (num) summary.grand_total = num;
      }
    }
  }

  return { items, summary, sheet_name: sheetName };
}

// ─── Shared item insert helper ────────────────────────────────────────────────
async function insertItems(client, quotationId, items) {
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    await client.query(
      `INSERT INTO quotation_items
         (quotation_id, item_no, sub_head, description, unit, quantity, rate, amount,
          basic_rate, discount, final_rate_after_discount, fittings,
          transportation, support, miscellaneous, total_material_price,
          labour, material_plus_labour, profit, total_rate, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        quotationId,
        item.item_no                   || null,
        item.sub_head                  || null,
        item.description               || null,
        item.unit                      || null,
        item.quantity                  || null,
        item.rate                      || null,
        item.amount                    || null,
        item.basic_rate                || null,
        item.discount                  || null,
        item.final_rate_after_discount || null,
        item.fittings                  || null,
        item.transportation            || null,
        item.support                   || null,
        item.miscellaneous             || null,
        item.total_material_price      || null,
        item.labour                    || null,
        item.material_plus_labour      || null,
        item.profit                    || null,
        item.total_rate                || null,
        idx + 1,
      ]
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  ⚠️  ALL STATIC ROUTES MUST BE DECLARED BEFORE  /:id  ROUTES
//  Reason: Express matches routes top-down. If /:id comes first, the string
//  "import" gets matched as an id param and returns 404.
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * tags:
 *   name: Quotations
 *   description: Quotation (BOQ) management
 */

// ─── STANDALONE UPLOAD (BOQ / Drawings) ───────────────────────────────────────
/**
 * @swagger
 * /api/quotation/upload:
 *   post:
 *     summary: Upload BOQ or Drawing files independently
 *     tags: [Quotations]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               boq:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: BOQ files
 *               drawing:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: Drawing files
 *     responses:
 *       200:
 *         description: Files uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 boq_files:
 *                   type: array
 *                   items:
 *                     type: string
 *                 drawing_files:
 *                   type: array
 *                   items:
 *                     type: string
 */
router.post(
  "/upload",
  standaloneUpload.fields([
    { name: "boq", maxCount: 10 },
    { name: "drawing", maxCount: 10 },
  ]),
  (req, res) => {
    try {
      const boq_files = req.files["boq"]
        ? req.files["boq"].map((f) => `/uploads/quotations/boq/${f.filename}`)
        : [];
      const drawing_files = req.files["drawing"]
        ? req.files["drawing"].map((f) => `/uploads/quotations/drawings/${f.filename}`)
        : [];

      res.json({
        success: true,
        boq_files,
        drawing_files,
      });
    } catch (error) {
      console.error("Error uploading files:", error);
      res.status(500).json({ error: error.message });
    }
  }
);

// ─── IMPORT Excel → parse → preview or save ───────────────────────────────────
/**
 * @swagger
 * /api/quotations/import/excel:
 *   post:
 *     summary: Upload a BOQ Excel (.xls / .xlsx) and get back parsed quotation data
 *     tags: [Quotations]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: BOQ Excel file (.xls or .xlsx)
 *               project_name:
 *                 type: string
 *               client_name:
 *                 type: string
 *               save:
 *                 type: string
 *                 description: Pass "true" to auto-save parsed data to DB
 *               created_by:
 *                 type: string
 *               created_by_name:
 *                 type: string
 *     responses:
 *       200:
 *         description: Parsed BOQ data (preview mode — not saved)
 *       201:
 *         description: Quotation saved to DB (save=true)
 *       400:
 *         description: No file uploaded or wrong file type
 *       500:
 *         description: Server error
 */
router.post("/import/excel", uploadExcel.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded. Send Excel as field name 'file'." });
  }

  try {
    const { items, summary, sheet_name } = parseBOQExcel(req.file.path);

    const totalAmount = summary.total_amount || items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    const gstPct      = 18;
    const gstAmount   = summary.gst_amount  || parseFloat(((totalAmount * gstPct) / 100).toFixed(2));
    const grandTotal  = summary.grand_total || parseFloat((totalAmount + gstAmount).toFixed(2));

    const payload = {
      project_name:   req.body.project_name  || null,
      client_name:    req.body.client_name   || null,
      quotation_date: new Date().toISOString().split("T")[0],
      gst_percentage: gstPct,
      total_amount:   totalAmount,
      gst_amount:     gstAmount,
      grand_total:    grandTotal,
      boq_files:      [`/uploads/quotations/${req.file.filename}`],
      parsed_sheet:   sheet_name,
      items_count:    items.length,
      items,
      summary,
    };

    if (req.body.save === "true") {
      const dbClient = await pool.connect();
      try {
        await dbClient.query("BEGIN");

        const quotResult = await dbClient.query(
          `INSERT INTO quotations
             (project_name, client_name, quotation_date, total_amount,
              gst_percentage, gst_amount, grand_total, boq_files,
              status, created_by, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10)
           RETURNING *`,
          [
            payload.project_name,
            payload.client_name,
            payload.quotation_date,
            totalAmount, gstPct, gstAmount, grandTotal,
            JSON.stringify(payload.boq_files),
            req.body.created_by      || null,
            req.body.created_by_name || null,
          ]
        );
        const quotation = quotResult.rows[0];
        await insertItems(dbClient, quotation.id, items);
        await dbClient.query("COMMIT");

        return res.status(201).json({
          message:        "Quotation imported and saved",
          quotation_id:   quotation.id,
          items_imported: items.length,
          ...payload,
        });
      } catch (err) {
        await dbClient.query("ROLLBACK");
        throw err;
      } finally {
        dbClient.release();
      }
    }

    res.json({
      message: `Parsed ${items.length} BOQ items from sheet "${sheet_name}"`,
      ...payload,
    });
  } catch (err) {
    console.error("Import excel error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── CREATE Quotation (JSON) ──────────────────────────────────────────────────
/**
 * @swagger
 * /api/quotations:
 *   post:
 *     summary: Create a new quotation with BOQ items
 *     tags: [Quotations]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               project_name:             { type: string }
 *               client_name:              { type: string }
 *               quotation_no:             { type: string }
 *               quotation_date:           { type: string, format: date }
 *               gst_percentage:           { type: number, default: 18 }
 *               boq_files:
 *                 type: array
 *                 items:
 *                   type: string
 *               drawing_files:
 *                 type: array
 *                 items:
 *                   type: string
 *               last_date_revised_offer:   { type: string, format: date }
 *               is_revised_offer:         { type: boolean, default: false }
 *               notes:                    { type: string }
 *               created_by:               { type: string }
 *               created_by_name:          { type: string }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     item_no:                   { type: string }
 *                     sub_head:                  { type: string }
 *                     description:               { type: string }
 *                     unit:                      { type: string }
 *                     quantity:                  { type: number }
 *                     rate:                      { type: number }
 *                     amount:                    { type: number }
 *                     basic_rate:                { type: number }
 *                     discount:                  { type: number }
 *                     final_rate_after_discount: { type: number }
 *                     fittings:                  { type: number }
 *                     transportation:            { type: number }
 *                     support:                   { type: number }
 *                     miscellaneous:             { type: number }
 *                     total_material_price:      { type: number }
 *                     labour:                    { type: number }
 *                     material_plus_labour:      { type: number }
 *                     profit:                    { type: number }
 *                     total_rate:                { type: number }
 *     responses:
 *       201:
 *         description: Quotation created
 *       500:
 *         description: Server error
 */
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const {
      project_name, client_name, quotation_no, quotation_date,
      gst_percentage = 18, boq_files = [], drawing_files = [], last_date_revised_offer,
      is_revised_offer = false, notes, created_by, created_by_name,
      items = [],
    } = req.body;

    const totalAmount = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    const gstAmount   = parseFloat(((totalAmount * gst_percentage) / 100).toFixed(2));
    const grandTotal  = parseFloat((totalAmount + gstAmount).toFixed(2));

    const quotResult = await client.query(
      `INSERT INTO quotations
         (project_name, client_name, quotation_no, quotation_date,
          total_amount, gst_percentage, gst_amount, grand_total,
          boq_files, drawing_files, last_date_revised_offer, is_revised_offer,
          notes, status, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'draft',$14,$15)
       RETURNING *`,
      [
        project_name || null, client_name || null,
        quotation_no || null, quotation_date || null,
        totalAmount, gst_percentage, gstAmount, grandTotal,
        JSON.stringify(boq_files), JSON.stringify(drawing_files), last_date_revised_offer || null,
        is_revised_offer, notes || null, created_by || null, created_by_name || null,
      ]
    );

    const quotation = quotResult.rows[0];
    await insertItems(client, quotation.id, items);
    await client.query("COMMIT");

    logActivity({
      action: "created", entity_type: "quotation",
      entity_id: quotation.id, entity_name: quotation.project_name,
      performed_by: created_by || null, performed_by_name: created_by_name || null,
    });

    res.status(201).json({
      message:   "Quotation created successfully",
      quotation: { ...quotation, items_count: items.length },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Create quotation error:", err);

    // Handle unique constraint violation for quotation_no
    if (err.code === "23505") {
      return res.status(400).json({
        error: `Quotation number '${req.body.quotation_no}' already exists. Please use a unique number.`
      });
    }

    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── GET All Quotations ───────────────────────────────────────────────────────
/**
 * @swagger
 * /api/quotations:
 *   get:
 *     summary: Get all quotations
 *     tags: [Quotations]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [draft, sent, approved, rejected] } }
 *       - { in: query, name: is_revised_offer, schema: { type: boolean } }
 *     responses:
 *       200:
 *         description: List of quotations
 */
router.get("/", async (req, res) => {
  try {
    const { status, is_revised_offer } = req.query;
    let query = "SELECT * FROM quotations";
    const params = [], conditions = [];

    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }
    if (is_revised_offer !== undefined) {
      params.push(is_revised_offer === "true");
      conditions.push(`is_revised_offer = $${params.length}`);
    }
    if (conditions.length) query += " WHERE " + conditions.join(" AND ");
    query += " ORDER BY created_at DESC";

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("Get quotations error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── UPLOAD BOQ File (attach to existing quotation) ──────────────────────────
/**
 * @swagger
 * /api/quotations/{id}/upload/boq:
 *   post:
 *     summary: Upload a BOQ file and attach it to a quotation
 *     tags: [Quotations]
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
 *             required: [file]
 *             properties:
 *               file:             { type: string, format: binary }
 *               uploaded_by:      { type: string }
 *               uploaded_by_name: { type: string }
 *     responses:
 *       200:
 *         description: BOQ file uploaded and path saved to quotation
 *       400:
 *         description: No file uploaded
 *       404:
 *         description: Quotation not found
 */
router.post("/:id/upload/boq", uploadBOQ.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const { id } = req.params;
    const filePath    = `/uploads/quotations/boq/${req.file.filename}`;

    // Append to the boq_files array
    const result = await pool.query(
      `UPDATE quotations
       SET boq_files = boq_files || $1::jsonb, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [JSON.stringify([filePath]), id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Quotation not found" });
    }

    logActivity({
      action: "boq_file_uploaded", entity_type: "quotation",
      entity_id: id, entity_name: result.rows[0].project_name,
      performed_by: req.body.uploaded_by || null,
      performed_by_name: req.body.uploaded_by_name || null,
    });

    res.json({
      message:       "BOQ file uploaded successfully",
      file_path:     filePath,
      quotation:     result.rows[0],
    });
  } catch (err) {
    console.error("Upload BOQ error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── UPLOAD Drawings (multiple files) ────────────────────────────────────────
/**
 * @swagger
 * /api/quotations/{id}/upload/drawings:
 *   post:
 *     summary: Upload one or more drawing files and attach them to a quotation
 *     tags: [Quotations]
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
 *             required: [files]
 *             properties:
 *               files:
 *                 type: array
 *                 items: { type: string, format: binary }
 *               uploaded_by:      { type: string }
 *               uploaded_by_name: { type: string }
 *     responses:
 *       200:
 *         description: Drawing files uploaded
 *       400:
 *         description: No files uploaded
 *       404:
 *         description: Quotation not found
 */
router.post("/:id/upload/drawings", uploadDrawings.array("files", 20), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded. Use field name 'files'." });
    }

    const { id } = req.params;
    const check = await pool.query(
      "SELECT id, project_name FROM quotations WHERE id = $1",
      [id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: "Quotation not found" });
    }

    const filePaths = req.files.map((f) => `/uploads/quotations/drawings/${f.filename}`);

    const result = await pool.query(
      `UPDATE quotations
       SET drawing_files = drawing_files || $1::jsonb, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [JSON.stringify(filePaths), id]
    );

    logActivity({
      action: "drawings_uploaded", entity_type: "quotation",
      entity_id: id, entity_name: check.rows[0].project_name,
      performed_by: req.body.uploaded_by || null,
      performed_by_name: req.body.uploaded_by_name || null,
    });

    res.json({ message: `${filePaths.length} drawing(s) uploaded`, quotation: result.rows[0] });
  } catch (err) {
    console.error("Upload drawings error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET Single Quotation (with items + drawings) ─────────────────────────────
/**
 * @swagger
 * /api/quotations/{id}:
 *   get:
 *     summary: Get a quotation with all BOQ items and drawings
 *     tags: [Quotations]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Quotation object with items and drawings arrays
 *       404:
 *         description: Quotation not found
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const quotResult = await pool.query(
      "SELECT * FROM quotations WHERE id = $1",
      [id]
    );
    if (quotResult.rows.length === 0) {
      return res.status(404).json({ error: "Quotation not found" });
    }

    const itemsResult = await pool.query(
      "SELECT * FROM quotation_items WHERE quotation_id = $1 ORDER BY sort_order, id",
      [id]
    );

    res.json({
      ...quotResult.rows[0],
      items: itemsResult.rows,
    });
  } catch (err) {
    console.error("Get quotation error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── UPDATE Quotation ─────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/quotations/{id}:
 *   put:
 *     summary: Update quotation header and replace all items
 *     tags: [Quotations]
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
 *             properties:
 *               project_name:             { type: string }
 *               client_name:              { type: string }
 *               quotation_no:             { type: string }
 *               quotation_date:           { type: string, format: date }
 *               gst_percentage:           { type: number, default: 18 }
 *               boq_files:
 *                 type: array
 *                 items:
 *                   type: string
 *               drawing_files:
 *                 type: array
 *                 items:
 *                   type: string
 *               last_date_revised_offer:   { type: string, format: date }
 *               is_revised_offer:         { type: boolean }
 *               status:                   { type: string, enum: [draft, sent, approved, rejected] }
 *               notes:                    { type: string }
 *               updated_by:               { type: string }
 *               updated_by_name:          { type: string }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     item_no:                   { type: string }
 *                     sub_head:                  { type: string }
 *                     description:               { type: string }
 *                     unit:                      { type: string }
 *                     quantity:                  { type: number }
 *                     rate:                      { type: number }
 *                     amount:                    { type: number }
 *                     basic_rate:                { type: number }
 *                     discount:                  { type: number }
 *                     final_rate_after_discount: { type: number }
 *                     fittings:                  { type: number }
 *                     transportation:            { type: number }
 *                     support:                   { type: number }
 *                     miscellaneous:             { type: number }
 *                     total_material_price:      { type: number }
 *                     labour:                    { type: number }
 *                     material_plus_labour:      { type: number }
 *                     profit:                    { type: number }
 *                     total_rate:                { type: number }
 *     responses:
 *       200:
 *         description: Quotation updated
 *       404:
 *         description: Quotation not found
 */
router.put("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { id } = req.params;
    const {
      project_name, client_name, quotation_no, quotation_date,
      gst_percentage = 18, boq_files = [], drawing_files = [], last_date_revised_offer,
      is_revised_offer, status, notes, updated_by, updated_by_name,
      items = [],
    } = req.body;

    const check = await client.query("SELECT id, edit_history FROM quotations WHERE id = $1", [id]);
    if (check.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Quotation not found" });
    }

    const currentHistory = check.rows[0].edit_history || [];
    const newHistoryEntry = {
        updated_by: updated_by || null,
        updated_by_name: updated_by_name || null,
        updated_at: new Date().toISOString(),
        action: "Quotation updated",
      };
    const updatedHistory = [...currentHistory, newHistoryEntry];

    const totalAmount = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    const gstAmount   = parseFloat(((totalAmount * gst_percentage) / 100).toFixed(2));
    const grandTotal  = parseFloat((totalAmount + gstAmount).toFixed(2));

    const quotResult = await client.query(
      `UPDATE quotations SET
         project_name            = $1,
         client_name             = $2,
         quotation_no            = $3,
         quotation_date          = $4,
         total_amount            = $5,
         gst_percentage          = $6,
         gst_amount              = $7,
         grand_total             = $8,
         boq_files               = $9,
         drawing_files           = $10,
         last_date_revised_offer = COALESCE($11, last_date_revised_offer),
         is_revised_offer        = COALESCE($12, is_revised_offer),
         status                  = COALESCE($13, status),
         notes                   = $14,
         updated_by              = $15,
         updated_by_name         = $16,
         edit_history            = $17,
         updated_at              = NOW()
       WHERE id = $18 RETURNING *`,
      [
        project_name, client_name || null,
        quotation_no || null, quotation_date || null,
        totalAmount, gst_percentage, gstAmount, grandTotal,
        JSON.stringify(boq_files), JSON.stringify(drawing_files),
        last_date_revised_offer || null,
        is_revised_offer != null ? is_revised_offer : null,
        status || null, notes || null,
        updated_by || null, updated_by_name || null,
        JSON.stringify(updatedHistory), id,
      ]
    );

    await client.query("DELETE FROM quotation_items WHERE quotation_id = $1", [id]);
    await insertItems(client, id, items);
    await client.query("COMMIT");

    logActivity({
      action: "updated", entity_type: "quotation",
      entity_id: id, entity_name: project_name,
      performed_by: updated_by || null, performed_by_name: updated_by_name || null,
    });

    res.json({ message: "Quotation updated successfully", quotation: quotResult.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Update quotation error:", err);

    // Handle unique constraint violation for quotation_no
    if (err.code === "23505") {
      return res.status(400).json({
        error: `Quotation number '${req.body.quotation_no}' already exists. Please use a unique number.`
      });
    }

    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── DELETE Quotation ─────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/quotations/{id}:
 *   delete:
 *     summary: Delete a quotation and all its items and drawings
 *     tags: [Quotations]
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { id } = req.params;

    const check = await client.query(
      "SELECT id, project_name FROM quotations WHERE id = $1",
      [id]
    );
    if (check.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Quotation not found" });
    }
    const { project_name } = check.rows[0];

    await client.query("DELETE FROM quotation_drawings WHERE quotation_id = $1", [id]);
    await client.query("DELETE FROM quotation_items WHERE quotation_id = $1", [id]);
    await client.query("DELETE FROM quotations WHERE id = $1", [id]);
    await client.query("COMMIT");

    logActivity({
      action: "deleted", entity_type: "quotation",
      entity_id: id, entity_name: project_name,
      performed_by: req.body?.deleted_by || null,
      performed_by_name: req.body?.deleted_by_name || null,
    });

    res.json({ message: "Quotation deleted successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Delete quotation error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── PATCH Status ─────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/quotations/{id}/status:
 *   patch:
 *     summary: Update quotation status
 *     tags: [Quotations]
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
 *             required: [status]
 *             properties:
 *               status:          { type: string, enum: [draft, sent, approved, rejected] }
 *               updated_by:      { type: string }
 *               updated_by_name: { type: string }
 *     responses:
 *       200:
 *         description: Status updated
 *       400:
 *         description: Invalid status
 *       404:
 *         description: Not found
 */
router.patch("/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, updated_by, updated_by_name } = req.body;

    const allowed = ["draft", "sent", "approved", "rejected"];
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(", ")}` });
    }

    const check = await pool.query("SELECT id, edit_history FROM quotations WHERE id = $1", [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: "Quotation not found" });
    }

    const currentHistory = check.rows[0].edit_history || [];
    const newHistoryEntry = {
      updated_by: updated_by || null,
      updated_by_name: updated_by_name || null,
      updated_at: new Date().toISOString(),
      action: `Status changed to ${status}`,
    };
    const updatedHistory = [...currentHistory, newHistoryEntry];

    const result = await pool.query(
      `UPDATE quotations SET 
         status = $1, 
         updated_by = $2, 
         updated_by_name = $3, 
         edit_history = $4,
         updated_at = NOW() 
       WHERE id = $5 RETURNING *`,
      [status, updated_by || null, updated_by_name || null, JSON.stringify(updatedHistory), id]
    );

    logActivity({
      action: `status_changed_to_${status}`, entity_type: "quotation",
      entity_id: id, entity_name: result.rows[0].project_name,
      performed_by: updated_by || null, performed_by_name: updated_by_name || null,
    });

    res.json({ message: `Status updated to ${status}`, quotation: result.rows[0] });
  } catch (err) {
    console.error("Update status error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;