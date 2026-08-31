const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const { logActivity, getEntityHistory, attachCreatedUpdatedBy } = require("./dashboard");
const {
  recalculateItems,
  buildAddonKeys,
  computeTotals,
} = require("../utils/boqCalculator");

// ─── Upload directories ───────────────────────────────────────────────────────
const uploadDir  = path.join(__dirname, "../../uploads/quotations");
const boqDir     = path.join(__dirname, "../../uploads/quotations/boq");
const drawingDir = path.join(__dirname, "../../uploads/quotations/drawings");

[uploadDir, boqDir, drawingDir].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── Multer: Excel only (for /import/excel) ───────────────────────────────────
const excelStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, boqDir),
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
      const dest = file.fieldname === "boq" ? boqDir : drawingDir;
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
  const dataStartRow = headerRowIdx + 2;

  for (let i = dataStartRow; i < raw.length; i++) {
    const row = raw[i];
    if (!row) continue;

    const itemNo      = row[1];
    const description = row[2];

    if (!itemNo || !description) continue;
    if (typeof itemNo === "string" && /^[A-Z]\.?$/.test(String(itemNo).trim())) continue;
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
    const result = await client.query(
      `INSERT INTO quotation_items
         (quotation_id, item_no, sub_head, description, unit, quantity, rate, amount,
          basic_rate, discount, final_rate_after_discount, fittings,
          transportation, support, miscellaneous, total_material_price,
          labour, material_plus_labour, profit, total_rate, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id`,
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

    // ── Insert dynamic field values if provided ──────────────────────────────
    // item.dynamic_values = [{ field_key: "erection_cost", value: 500 }, ...]
    if (Array.isArray(item.dynamic_values) && item.dynamic_values.length > 0) {
      const itemId = result.rows[0].id;

      for (const dv of item.dynamic_values) {
        if (!dv.field_key) continue;

        // Resolve field_id from field_key
        const fieldRow = await client.query(
          `SELECT id, data_type FROM quotation_field_definitions WHERE field_key = $1 AND is_active = TRUE`,
          [dv.field_key]
        );
        if (fieldRow.rows.length === 0) continue;

        const { id: field_id, data_type } = fieldRow.rows[0];
        const numericValue = data_type === "text" ? null : (dv.value != null ? Number(dv.value) : null);
        const textValue    = data_type === "text" ? (dv.value != null ? String(dv.value) : null) : null;

        await client.query(
          `INSERT INTO quotation_item_dynamic_values (item_id, field_id, value, text_value, computed)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (item_id, field_id) DO UPDATE
             SET value = EXCLUDED.value, text_value = EXCLUDED.text_value, computed = EXCLUDED.computed`,
          [itemId, field_id, numericValue, textValue, dv.computed || false]
        );
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  ⚠️  ALL STATIC ROUTES MUST BE DECLARED BEFORE  /:id  ROUTES
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * tags:
 *   name: Quotations
 *   description: |
 *     Quotation (BOQ) management. Every GET (list/by-id) response also
 *     includes created_by/created_by_name/updated_by/updated_by_name — see
 *     the CreatedUpdatedBy schema (note: this is separate from the
 *     quotation's own request-body created_by/updated_by fields used at
 *     create/update time).
 */

// ═══════════════════════════════════════════════════════════════════════════
//  DYNAMIC FIELD DEFINITIONS
//  These two endpoints let the UI manage custom columns for the BOQ grid.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/quotations/fields:
 *   get:
 *     summary: Get all quotation item field definitions (static + dynamic)
 *     description: |
 *       Returns the ordered list of column definitions that the quotation
 *       Excel-like UI should render. Each field carries its label, data type,
 *       optional formula (for auto-calculated columns), and active flag.
 *
 *       **Formula syntax**
 *       Variables are wrapped in curly braces and refer to other `field_key`
 *       values in the same row. Examples:
 *         - `{quantity} * {rate}`
 *         - `{basic_rate} * (1 - {discount} / 100)`
 *         - `{total_material_price} + {labour}`
 *
 *       The UI should evaluate these client-side (or server-side) whenever a
 *       dependency value changes.
 *     tags: [Quotations]
 *     parameters:
 *       - in: query
 *         name: active_only
 *         schema: { type: boolean, default: true }
 *         description: When true (default), returns only active fields.
 *     responses:
 *       200:
 *         description: Ordered list of field definitions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 fields:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:          { type: integer }
 *                       field_key:   { type: string, example: "erection_cost" }
 *                       label:       { type: string, example: "Erection Cost" }
 *                       data_type:   { type: string, enum: [number, text, percent] }
 *                       formula:     { type: string, nullable: true, example: "{quantity} * {rate}" }
 *                       description: { type: string, nullable: true }
 *                       is_active:   { type: boolean }
 *                       sort_order:  { type: integer }
 *       500:
 *         description: Server error
 */
router.get("/fields", async (req, res) => {
  try {
    const activeOnly = req.query.active_only !== "false"; // default: true
    const query = activeOnly
      ? `SELECT * FROM quotation_field_definitions WHERE is_active = TRUE ORDER BY sort_order, id`
      : `SELECT * FROM quotation_field_definitions ORDER BY sort_order, id`;

    const result = await pool.query(query);
    res.json({ fields: result.rows });
  } catch (err) {
    console.error("Get quotation fields error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/quotations/fields:
 *   post:
 *     summary: Add a custom dynamic field to quotation items
 *     description: |
 *       Creates a new column definition. Once created the UI will render it
 *       as an extra column in the BOQ grid for every quotation.
 *
 *       **Formula variables** reference other `field_key` values in curly
 *       braces: `{basic_rate}`, `{quantity}`, etc. Leave `formula` null for
 *       a plain editable column.
 *
 *       **`field_key` rules**:
 *       - lowercase, underscores only (e.g. `erection_cost`)
 *       - must be unique across all definitions
 *       - cannot shadow a built-in column name
 *     tags: [Quotations]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [field_key, label]
 *             properties:
 *               field_key:
 *                 type: string
 *                 example: erection_cost
 *                 description: Machine-readable key (lowercase + underscores, unique)
 *               label:
 *                 type: string
 *                 example: Erection Cost
 *                 description: Column header shown in the UI
 *               data_type:
 *                 type: string
 *                 enum: [number, text, percent]
 *                 default: number
 *               field_role:
 *                 type: string
 *                 enum: [input, percent_addon, base, derived, text]
 *                 default: input
 *                 description: |
 *                   How this field participates in the calculation engine:
 *                   - **input** – plain editable field, not part of any formula
 *                   - **percent_addon** – value is added into percentSum →
 *                     increases total_rate by (basicRate × value / 100).
 *                     Use this for any new charge column that should behave
 *                     like fittings, labour, profit, etc.
 *                   - **base** – alternative base rate (like `rate`); only used
 *                     as fallback when `basic_rate` is absent.
 *                   - **derived** – computed by the engine; read-only in the UI.
 *                   - **text** – non-numeric, never calculated.
 *               formula_description:
 *                 type: string
 *                 nullable: true
 *                 description: Human-readable description of the formula (for tooltips). Not evaluated at runtime.
 *               description:
 *                 type: string
 *                 nullable: true
 *                 description: Tooltip / notes shown in the UI
 *               sort_order:
 *                 type: integer
 *                 default: 0
 *                 description: Display position (lower = further left)
 *               created_by:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       201:
 *         description: Field definition created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 field:
 *                   type: object
 *                   properties:
 *                     id:          { type: integer }
 *                     field_key:   { type: string }
 *                     label:       { type: string }
 *                     data_type:   { type: string }
 *                     formula:     { type: string, nullable: true }
 *                     description: { type: string, nullable: true }
 *                     is_active:   { type: boolean }
 *                     sort_order:  { type: integer }
 *       400:
 *         description: Validation error (missing field_key / label, or duplicate key)
 *       500:
 *         description: Server error
 */
router.post("/fields", async (req, res) => {
  try {
    const {
      field_key,
      label,
      data_type           = "number",
      field_role          = "input",
      formula_description = null,
      description         = null,
      sort_order          = 0,
      created_by          = null,
    } = req.body;

    // ── Validation ───────────────────────────────────────────────────────────
    if (!field_key || !label) {
      return res.status(400).json({ error: "field_key and label are required." });
    }

    if (!/^[a-z][a-z0-9_]*$/.test(field_key)) {
      return res.status(400).json({
        error: "field_key must start with a lowercase letter and contain only lowercase letters, digits, and underscores.",
      });
    }

    const allowed_data_types = ["number", "text", "percent"];
    if (!allowed_data_types.includes(data_type)) {
      return res.status(400).json({
        error: `data_type must be one of: ${allowed_data_types.join(", ")}`,
      });
    }

    const allowed_roles = ["input", "percent_addon", "base", "derived", "text"];
    if (!allowed_roles.includes(field_role)) {
      return res.status(400).json({
        error: `field_role must be one of: ${allowed_roles.join(", ")}`,
      });
    }

    // ── Insert ───────────────────────────────────────────────────────────────
    const result = await pool.query(
      `INSERT INTO quotation_field_definitions
         (field_key, label, data_type, field_role, formula_description, description, sort_order, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [field_key, label, data_type, field_role, formula_description, description, sort_order, created_by]
    );

    logActivity({
      action: "created",
      entity_type: "quotation_field",
      entity_id: result.rows[0].id,
      entity_name: label,
      performed_by: created_by || null,
      performed_by_name: null,
    });

    res.status(201).json({
      message: `Dynamic field "${label}" created successfully.`,
      field: result.rows[0],
    });
  } catch (err) {
    console.error("Create quotation field error:", err);

    if (err.code === "23505") {
      return res.status(400).json({
        error: `A field with field_key "${req.body.field_key}" already exists.`,
      });
    }

    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/quotations/fields/{id}:
 *   put:
 *     summary: Update a dynamic field definition
 *     description: Update label, formula, data_type, description, sort_order, or active flag.
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
 *               label:       { type: string }
 *               data_type:   { type: string, enum: [number, text, percent] }
 *               formula:     { type: string, nullable: true }
 *               description: { type: string, nullable: true }
 *               sort_order:  { type: integer }
 *               is_active:   { type: boolean }
 *     responses:
 *       200:
 *         description: Field updated
 *       404:
 *         description: Field not found
 *       500:
 *         description: Server error
 */
router.put("/fields/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      label,
      data_type,
      field_role,
      formula_description,
      description,
      sort_order,
      is_active,
    } = req.body;

    const check = await pool.query(
      "SELECT * FROM quotation_field_definitions WHERE id = $1",
      [id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: "Field definition not found." });
    }

    const existing = check.rows[0];

    const result = await pool.query(
      `UPDATE quotation_field_definitions SET
         label               = COALESCE($1, label),
         data_type           = COALESCE($2, data_type),
         field_role          = COALESCE($3, field_role),
         formula_description = $4,
         description         = $5,
         sort_order          = COALESCE($6, sort_order),
         is_active           = COALESCE($7, is_active),
         updated_at          = NOW()
       WHERE id = $8
       RETURNING *`,
      [
        label       ?? null,
        data_type   ?? null,
        field_role  ?? null,
        formula_description !== undefined ? formula_description : existing.formula_description,
        description         !== undefined ? description         : existing.description,
        sort_order  ?? null,
        is_active   !== undefined ? is_active : null,
        id,
      ]
    );

    res.json({ message: "Field updated.", field: result.rows[0] });
  } catch (err) {
    console.error("Update quotation field error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/quotations/fields/{id}:
 *   delete:
 *     summary: Deactivate (soft-delete) a dynamic field definition
 *     description: Sets is_active = FALSE. Existing stored values are preserved.
 *     tags: [Quotations]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Field deactivated
 *       404:
 *         description: Field not found
 */
router.delete("/fields/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE quotation_field_definitions SET is_active = FALSE, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Field definition not found." });
    }
    res.json({ message: "Field deactivated.", field: result.rows[0] });
  } catch (err) {
    console.error("Delete quotation field error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── STANDALONE UPLOAD (Drawings) ─────────────────────────────────────────────
/**
 * @swagger
 * /api/quotation/upload:
 *   post:
 *     summary: Upload Drawing files independently
 *     tags: [Quotations]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               drawing:
 *                 type: array
 *                 items: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: Files uploaded successfully
 */
router.post(
  "/upload",
  standaloneUpload.fields([{ name: "drawing", maxCount: 10 }]),
  (req, res) => {
    try {
      const drawing_files = req.files["drawing"]
        ? req.files["drawing"].map((f) => `/uploads/quotations/drawings/${f.filename}`)
        : [];

      res.json({ success: true, drawing_files });
    } catch (error) {
      console.error("Error uploading files:", error);
      res.status(500).json({ error: error.message });
    }
  }
);

// ─── IMPORT Excel → Upload & Parse ───────────────────────────────────────────
/**
 * @swagger
 * /api/quotations/import/excel:
 *   post:
 *     summary: Upload a BOQ Excel (.xls / .xlsx), parse it, and return parsed items
 *     tags: [Quotations]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: BOQ file uploaded and parsed
 *       400:
 *         description: No file or wrong type
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

    const file_url = `/uploads/quotations/boq/${req.file.filename}`;

    res.json({
      success: true,
      file_url,
      message: `Parsed ${items.length} BOQ items from sheet "${sheet_name}"`,
      items_count: items.length,
      total_amount: totalAmount,
      gst_amount: gstAmount,
      grand_total: grandTotal,
      items,
      summary,
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
 *     summary: Create a new quotation with BOQ items (supports dynamic fields)
 *     description: |
 *       Each item in the `items` array may include a `dynamic_values` array to
 *       supply values for custom dynamic fields. Example:
 *
 *       ```json
 *       {
 *         "description": "Cable tray 200mm",
 *         "quantity": 10,
 *         "rate": 500,
 *         "dynamic_values": [
 *           { "field_key": "erection_cost", "value": 200 },
 *           { "field_key": "testing_charges", "value": 50, "computed": false }
 *         ]
 *       }
 *       ```
 *
 *       Fields whose `formula` is set are typically computed client-side and
 *       submitted as `computed: true`.
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
 *               boq_files:                { type: array, items: { type: string } }
 *               drawing_files:            { type: array, items: { type: string } }
 *               last_date_revised_offer:  { type: string, format: date }
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
 *                     dynamic_values:
 *                       type: array
 *                       description: Values for custom dynamic fields
 *                       items:
 *                         type: object
 *                         required: [field_key]
 *                         properties:
 *                           field_key: { type: string, example: "erection_cost" }
 *                           value:     { type: number }
 *                           computed:  { type: boolean, default: false }
 *     responses:
 *       201:
 *         description: Quotation created
 *       400:
 *         description: Duplicate quotation_no
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
      items: rawItems = [],
    } = req.body;

    // ── Server-side recalculation (mirrors QuotesCreate.jsx) ────────────────
    // Fetch active field definitions so we know which dynamic fields are
    // percent_addon (they also contribute to percentSum / total_rate).
    const fieldDefsResult = await client.query(
      "SELECT field_key, field_role FROM quotation_field_definitions WHERE is_active = TRUE"
    );
    const addonKeys = buildAddonKeys(fieldDefsResult.rows);
    const items     = recalculateItems(rawItems, addonKeys);
    // ────────────────────────────────────────────────────────────────────────

    const totalAmount = computeTotals(items).total_amount;
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
        JSON.stringify(boq_files), JSON.stringify(drawing_files),
        last_date_revised_offer || null,
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

    if (err.code === "23505") {
      return res.status(400).json({
        error: `Quotation number '${req.body.quotation_no}' already exists. Please use a unique number.`,
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
 *       - { in: query, name: status, schema: { type: string, enum: [all, draft, pending, sent, approved, rejected], default: all } }
 *       - { in: query, name: is_revised_offer, schema: { type: boolean } }
 *     responses:
 *       200:
 *         description: List of quotations
 */
router.get("/", async (req, res) => {
  try {
    const { status = "all", is_revised_offer } = req.query;
    let query = "SELECT * FROM quotations";
    const params = [], conditions = [];

    if (status && status !== "all") {
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
    res.json(await attachCreatedUpdatedBy(result.rows, "quotation", (r) => r.id));
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
 *         description: BOQ file uploaded
 *       400:
 *         description: No file
 *       404:
 *         description: Quotation not found
 */
router.post("/:id/upload/boq", uploadBOQ.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const { id } = req.params;
    const filePath = `/uploads/quotations/boq/${req.file.filename}`;

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

    res.json({ message: "BOQ file uploaded successfully", file_path: filePath, quotation: result.rows[0] });
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
 *     summary: Upload drawing files and attach to a quotation
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
 *               files: { type: array, items: { type: string, format: binary } }
 *               uploaded_by:      { type: string }
 *               uploaded_by_name: { type: string }
 *     responses:
 *       200:
 *         description: Drawing files uploaded
 *       400:
 *         description: No files
 *       404:
 *         description: Quotation not found
 */
router.post("/:id/upload/drawings", uploadDrawings.array("files", 20), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded. Use field name 'files'." });
    }

    const { id } = req.params;
    const check = await pool.query("SELECT id, project_name FROM quotations WHERE id = $1", [id]);
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

// ─── GET Single Quotation (with items + dynamic values) ───────────────────────
/**
 * @swagger
 * /api/quotations/{id}:
 *   get:
 *     summary: Get a quotation with all BOQ items including dynamic field values
 *     description: |
 *       Each item in the returned `items` array includes a `dynamic_values`
 *       object keyed by `field_key` for quick client-side access. Example:
 *
 *       ```json
 *       {
 *         "id": 42,
 *         "description": "Cable tray",
 *         "quantity": 10,
 *         "dynamic_values": {
 *           "erection_cost": { "value": 200, "computed": false },
 *           "testing_charges": { "value": 50, "computed": false }
 *         }
 *       }
 *       ```
 *     tags: [Quotations]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Quotation with items (including dynamic values)
 *       404:
 *         description: Quotation not found
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const quotResult = await pool.query("SELECT * FROM quotations WHERE id = $1", [id]);
    if (quotResult.rows.length === 0) {
      return res.status(404).json({ error: "Quotation not found" });
    }

    const itemsResult = await pool.query(
      "SELECT * FROM quotation_items WHERE quotation_id = $1 ORDER BY sort_order, id",
      [id]
    );

    // Attach dynamic values to each item
    const itemIds = itemsResult.rows.map((r) => r.id);
    let dynamicByItem = {};

    if (itemIds.length > 0) {
      const dvResult = await pool.query(
        `SELECT dv.item_id, dv.value, dv.text_value, dv.computed,
                fd.field_key, fd.label, fd.data_type
         FROM quotation_item_dynamic_values dv
         JOIN quotation_field_definitions fd ON fd.id = dv.field_id
         WHERE dv.item_id = ANY($1)`,
        [itemIds]
      );

      for (const row of dvResult.rows) {
        if (!dynamicByItem[row.item_id]) dynamicByItem[row.item_id] = {};
        dynamicByItem[row.item_id][row.field_key] = {
          value:     row.data_type === "text" ? row.text_value : row.value,
          label:     row.label,
          data_type: row.data_type,
          computed:  row.computed,
        };
      }
    }

    const items = itemsResult.rows.map((item) => ({
      ...item,
      dynamic_values: dynamicByItem[item.id] || {},
    }));

    const quotation = await attachCreatedUpdatedBy({ ...quotResult.rows[0], items }, "quotation", (r) => r.id);
    res.json(quotation);
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
 *     summary: Update quotation header and replace all items (supports dynamic fields)
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
 *             $ref: '#/components/schemas/QuotationCreateBody'
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
      items: rawItems = [],
    } = req.body;

    const check = await client.query("SELECT id, edit_history FROM quotations WHERE id = $1", [id]);
    if (check.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Quotation not found" });
    }

    // ── Server-side recalculation ────────────────────────────────────────────
    const fieldDefsResult = await client.query(
      "SELECT field_key, field_role FROM quotation_field_definitions WHERE is_active = TRUE"
    );
    const addonKeys = buildAddonKeys(fieldDefsResult.rows);
    const items     = recalculateItems(rawItems, addonKeys);
    // ────────────────────────────────────────────────────────────────────────

    const currentHistory = check.rows[0].edit_history || [];
    const newHistoryEntry = {
      updated_by: updated_by || null,
      updated_by_name: updated_by_name || null,
      updated_at: new Date().toISOString(),
      action: "Quotation updated",
    };
    const updatedHistory = [...currentHistory, newHistoryEntry];

    const totalAmount = computeTotals(items).total_amount;
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

    // Delete old items (cascade deletes dynamic values too)
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

    if (err.code === "23505") {
      return res.status(400).json({
        error: `Quotation number '${req.body.quotation_no}' already exists. Please use a unique number.`,
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
 *               status:          { type: string, enum: [draft, pending, sent, approved, rejected] }
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

    const allowed = ["draft", "pending", "sent", "approved", "rejected"];
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/quotations/:id/history — who created/updated/deleted this quotation, and when
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/quotations/{id}/history:
 *   get:
 *     summary: Get the create/update/delete history for a quotation (who did what, and when)
 *     tags: [Quotations]
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
 *         description: Activity history for this quotation
 */
router.get("/:id/history", async (req, res) => {
  try {
    const data = await getEntityHistory("quotation", req.params.id, {
      limit: req.query.limit, offset: req.query.offset,
    });
    res.json(data);
  } catch (err) {
    console.error("Error fetching quotation history:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;