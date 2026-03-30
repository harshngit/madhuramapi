/**
 * Bulk Inventory Upload from Excel
 * ─────────────────────────────────────────────────────────────────────────────
 * Add these routes to your existing vendor_price_list.js file,
 * OR mount this file separately in index.js as:
 *
 *   const bulkInventoryRoutes = require("./routes/vendor_price_list_bulk_inventory");
 *   app.use("/api/vendor-price-list", bulkInventoryRoutes);
 *
 * Required npm packages:
 *   npm install xlsx        ← for reading .xlsx / .xls files
 *
 * Endpoint:
 *   POST /api/vendor-price-list/bulk-upload-inventory
 *   Content-Type: multipart/form-data
 *   Fields:
 *     file         (required) .xlsx file matching the template
 *     vendor_id    (optional) link inventory items to a vendor price list
 *     project_id   (optional) default project_id for all rows (row-level overrides)
 *     user_id      (optional) for activity log
 *     user_name    (optional) for activity log
 *
 *   GET /api/vendor-price-list/bulk-upload-inventory/template
 *     Download the official Excel template
 */

const express = require("express");
const router  = express.Router();
const { pool } = require("../db");
const multer   = require("multer");
const path     = require("path");
const fs       = require("fs");
const XLSX     = require("xlsx");
const { logActivity }   = require("./dashboard");
const { recordMovement } = require("./inventory");

// ─── Upload dir ───────────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, "../../uploads/bulk_inventory");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + Math.round(Math.random() * 1e9) + path.extname(file.originalname));
  },
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".xlsx", ".xls"].includes(ext)) return cb(null, true);
    cb(new Error("Only .xlsx and .xls files are accepted"));
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
});

// ─── Template path ────────────────────────────────────────────────────────────
// Place inventory_bulk_upload_template.xlsx in src/templates/
const TEMPLATE_PATH = path.join(__dirname, "../templates/inventory_bulk_upload_template.xlsx");

// ─── Column names the template uses (must match exactly) ─────────────────────
const REQUIRED_COLS = ["name", "brand", "quantity", "units", "price"];
const OPTIONAL_COLS = ["width", "height", "stockin", "billing", "project_id", "notes"];
const ALL_COLS      = [...REQUIRED_COLS, ...OPTIONAL_COLS];

// ─── Row-level validator ──────────────────────────────────────────────────────
function validateRow(row, rowNum) {
  const errors = [];

  if (!row.name || String(row.name).trim() === "")
    errors.push(`Row ${rowNum}: "name" is required`);

  if (!row.brand || String(row.brand).trim() === "")
    errors.push(`Row ${rowNum}: "brand" is required`);

  const qty = parseFloat(row.quantity);
  if (row.quantity === undefined || row.quantity === "" || isNaN(qty))
    errors.push(`Row ${rowNum}: "quantity" must be a number`);
  else if (qty < 0)
    errors.push(`Row ${rowNum}: "quantity" cannot be negative`);

  if (!row.units || String(row.units).trim() === "")
    errors.push(`Row ${rowNum}: "units" is required`);

  const price = parseFloat(row.price);
  if (row.price === undefined || row.price === "" || isNaN(price))
    errors.push(`Row ${rowNum}: "price" must be a number`);
  else if (price < 0)
    errors.push(`Row ${rowNum}: "price" cannot be negative`);

  return errors;
}

// ─── Parse TRUE/FALSE strings ─────────────────────────────────────────────────
function parseBool(val, defaultVal = false) {
  if (typeof val === "boolean") return val;
  if (typeof val === "string") return val.trim().toUpperCase() === "TRUE";
  if (typeof val === "number") return val !== 0;
  return defaultVal;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vendor-price-list/bulk-upload-inventory/template
// Download the official Excel template
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/vendor-price-list/bulk-upload-inventory/template:
 *   get:
 *     summary: Download the official inventory bulk-upload Excel template
 *     tags: [Vendor Price List]
 *     responses:
 *       200:
 *         description: Excel file download
 *         content:
 *           application/vnd.openxmlformats-officedocument.spreadsheetml.sheet:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Template file not found on server
 */
router.get("/bulk-upload-inventory/template", (req, res) => {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    return res.status(404).json({
      error: "Template file not found. Please contact the administrator.",
      expected_path: TEMPLATE_PATH,
    });
  }
  res.download(TEMPLATE_PATH, "inventory_bulk_upload_template.xlsx");
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vendor-price-list/bulk-upload-inventory
//
// Upload an .xlsx file, parse the "Inventory_Upload" sheet,
// validate every row, then bulk-insert into the inventories table
// and record opening stock-in movements.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/vendor-price-list/bulk-upload-inventory:
 *   post:
 *     summary: Bulk upload inventory items from an Excel file
 *     tags: [Vendor Price List]
 *     description: |
 *       Upload the official template (.xlsx) filled with inventory data.
 *       The sheet named **Inventory_Upload** is read.
 *       Each row becomes one inventory item.
 *
 *       Required columns: name, brand, quantity, units, price
 *       Optional columns: width, height, stockin, billing, project_id, notes
 *
 *       Returns a detailed result: rows_imported, rows_skipped, errors per row.
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
 *                 description: Filled inventory_bulk_upload_template.xlsx
 *               vendor_id:
 *                 type: integer
 *                 description: Optional – link items to a vendor price list
 *               project_id:
 *                 type: integer
 *                 description: Default project_id for all rows (row column overrides this)
 *               user_id:
 *                 type: string
 *               user_name:
 *                 type: string
 *     responses:
 *       200:
 *         description: Import result with per-row details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:       { type: boolean }
 *                 total_rows:    { type: integer }
 *                 rows_imported: { type: integer }
 *                 rows_skipped:  { type: integer }
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       row:     { type: integer }
 *                       messages: { type: array, items: { type: string } }
 *                 imported_items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     description: Created inventory rows
 *       400:
 *         description: No file, wrong format, or all rows have errors
 *       500:
 *         description: Server error
 */
router.post(
  "/bulk-upload-inventory",
  upload.single("file"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const filePath   = req.file.path;
    const vendor_id  = req.body.vendor_id  ? Number(req.body.vendor_id)  : null;
    const default_project_id = req.body.project_id ? Number(req.body.project_id) : null;
    const performed_by      = req.body.user_id   || null;
    const performed_by_name = req.body.user_name || null;

    // ── Parse Excel ───────────────────────────────────────────────────────────
    let workbook;
    try {
      workbook = XLSX.readFile(filePath, { cellDates: true });
    } catch (err) {
      return res.status(400).json({ error: "Cannot read file. Make sure it is a valid .xlsx file." });
    }

    // Find the data sheet – must be named "Inventory_Upload"
    const sheetName = workbook.SheetNames.find(n => n === "Inventory_Upload");
    if (!sheetName) {
      return res.status(400).json({
        error: `Sheet "Inventory_Upload" not found. Sheets in file: ${workbook.SheetNames.join(", ")}`,
        hint: "Please use the official template. Download it from GET /api/vendor-price-list/bulk-upload-inventory/template",
      });
    }

    const sheet = workbook.Sheets[sheetName];

    // Convert to JSON – header row is row 2 (row 1 is the title banner)
    const rawRows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,       // get arrays first so we can find the header row
      defval: "",
      blankrows: false,
    });

    // Find which array index holds the header (look for "name" column)
    let headerRowIndex = -1;
    for (let i = 0; i < Math.min(rawRows.length, 5); i++) {
      if (rawRows[i].includes("name")) { headerRowIndex = i; break; }
    }
    if (headerRowIndex === -1) {
      return res.status(400).json({
        error: 'Could not find header row with column "name". Use the official template.',
      });
    }

    const headers  = rawRows[headerRowIndex].map(h => String(h).trim().toLowerCase());
    const dataRows = rawRows.slice(headerRowIndex + 1);

    // Verify required columns exist
    const missingCols = REQUIRED_COLS.filter(c => !headers.includes(c));
    if (missingCols.length > 0) {
      return res.status(400).json({
        error: `Missing required columns: ${missingCols.join(", ")}. Use the official template.`,
      });
    }

    // Map column name → index
    const colIdx = {};
    headers.forEach((h, i) => { colIdx[h] = i; });

    // Build row objects
    const parsedRows = dataRows
      .map((arr, i) => {
        const obj = {};
        ALL_COLS.forEach(col => {
          if (colIdx[col] !== undefined) {
            obj[col] = arr[colIdx[col]];
          }
        });
        obj._rowNum = headerRowIndex + 2 + i; // Excel 1-based row number
        return obj;
      })
      .filter(r => {
        // Skip completely empty rows
        return REQUIRED_COLS.some(c => r[c] !== "" && r[c] !== undefined && r[c] !== null);
      });

    if (parsedRows.length === 0) {
      return res.status(400).json({ error: "No data rows found in the Inventory_Upload sheet." });
    }

    // ── Validate all rows first (collect all errors before writing) ───────────
    const allErrors = [];
    const validRows = [];

    for (const row of parsedRows) {
      const rowErrors = validateRow(row, row._rowNum);
      if (rowErrors.length > 0) {
        allErrors.push({ row: row._rowNum, messages: rowErrors });
      } else {
        validRows.push(row);
      }
    }

    // ── Insert valid rows ─────────────────────────────────────────────────────
    const importedItems = [];
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      for (const row of validRows) {
        const qty    = parseFloat(row.quantity)  || 0;
        const price  = parseFloat(row.price)     || 0;
        const width  = row.width  !== "" && row.width  != null ? parseFloat(row.width)  : null;
        const height = row.height !== "" && row.height != null ? parseFloat(row.height) : null;
        const stockin  = parseBool(row.stockin,  false);
        const billing  = parseBool(row.billing,  false);
        const proj_id  = row.project_id && String(row.project_id).trim() !== ""
          ? Number(row.project_id)
          : default_project_id;

        const ins = await client.query(
          `INSERT INTO inventories
             (name, brand, quantity, current_quantity, units, price,
              width, height, stockin, billing, project_id, source_po_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING *`,
          [
            String(row.name).trim(),
            String(row.brand).trim(),
            qty, 0,   // current_quantity starts 0; recordMovement will set it
            String(row.units).trim(),
            price, width, height, stockin, billing,
            proj_id || null,
            vendor_id || null,   // loosely track the vendor via source_po_id field
          ]
        );

        const item = ins.rows[0];

        // Record opening stock-in movement
        if (qty > 0) {
          await recordMovement(client, {
            inventory_id:      item.inventory_id,
            movement_type:     "in",
            quantity:          qty,
            source_type:       "manual",
            source_id:         null,
            source_ref:        vendor_id ? `Vendor price list import (vendor #${vendor_id})` : "Bulk import",
            project_id:        proj_id,
            project_name:      null,
            notes:             row.notes ? String(row.notes).trim() : "Opening stock – bulk upload",
            performed_by,
            performed_by_name,
          });
        }

        importedItems.push({
          inventory_id: item.inventory_id,
          name:         item.name,
          brand:        item.brand,
          quantity:     qty,
          units:        item.units,
          price:        item.price,
          project_id:   proj_id,
          excel_row:    row._rowNum,
        });
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Bulk inventory insert error:", err.message);
      return res.status(500).json({ error: "Database error during import: " + err.message });
    } finally {
      client.release();
    }

    // ── Cleanup uploaded file ─────────────────────────────────────────────────
    fs.unlink(filePath, () => {});

    // ── Response ──────────────────────────────────────────────────────────────
    const result = {
      success:        importedItems.length > 0,
      total_rows:     parsedRows.length,
      rows_imported:  importedItems.length,
      rows_skipped:   allErrors.length,
      errors:         allErrors,       // per-row error details
      imported_items: importedItems,
    };

    res.status(importedItems.length > 0 ? 200 : 400).json(result);

    // Log activity
    if (importedItems.length > 0) {
      logActivity({
        action:            "bulk_imported",
        entity_type:       "inventory",
        entity_id:         null,
        entity_name:       `Bulk import – ${importedItems.length} items`,
        performed_by,
        performed_by_name,
        meta: {
          vendor_id,
          rows_imported: importedItems.length,
          rows_skipped:  allErrors.length,
        },
      });
    }
  }
);

module.exports = router;
