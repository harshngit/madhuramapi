const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const PDFParser = require("pdf2json");
const { pool } = require("../db");
const { logActivity } = require("./dashboard");

const router = express.Router();

// ─── Upload directory ─────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, "../../uploads/boq");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// ─── Multer config ────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, "boq-" + unique + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: safe URI decode
// ─────────────────────────────────────────────────────────────────────────────
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (_) { return s; }
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF PARSER — Generic (original, for Lodha-style BOQ)
//
// Columns:  item_no | description | unit | qty
// ─────────────────────────────────────────────────────────────────────────────
function parseBOQPdfNpm(filePath) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, 1);

    parser.on("pdfParser_dataError", (err) =>
      reject(new Error("PDF parse error: " + err))
    );

    parser.on("pdfParser_dataReady", (data) => {
      try {
        const pages = data.Pages || [];
        const allTexts = [];

        for (let pi = 0; pi < pages.length; pi++) {
          const yOffset = pi * 10000;
          for (const text of pages[pi].Texts || []) {
            allTexts.push({
              x: parseFloat(text.x.toFixed(3)),
              y: parseFloat(text.y.toFixed(3)) + yOffset,
              str: text.R.map((r) => safeDecode(r.T)).join(""),
            });
          }
        }

        allTexts.sort((a, b) => a.y - b.y || a.x - b.x);

        const ITEM_X_MAX = 6.5;
        const DESC_X_MIN = 6.5;
        const DESC_X_MAX = 27.5;
        const UNIT_X_MIN = 27.5;
        const UNIT_X_MAX = 30.5;
        const QTY_X_MIN  = 30.5;

        const itemAnchors = allTexts
          .filter((t) => /^\d+$/.test(t.str.trim()) && t.x < ITEM_X_MAX)
          .map((t) => ({ item_no: t.str.trim(), y: t.y }));

        const sectionAnchors = allTexts.filter(
          (t) => /^[A-Z]\.$/.test(t.str.trim()) && t.x < 7
        );

        const items = [];
        let currentSection = null;

        for (let i = 0; i < itemAnchors.length; i++) {
          const anchor = itemAnchors[i];
          const nextY =
            i + 1 < itemAnchors.length ? itemAnchors[i + 1].y : anchor.y + 20;

          const prevItemY = i > 0 ? itemAnchors[i - 1].y : 0;
          for (const sec of sectionAnchors) {
            if (sec.y >= prevItemY && sec.y < anchor.y) {
              const secLabel = allTexts
                .filter((t) => Math.abs(t.y - sec.y) < 0.5 && t.x >= 6.0)
                .map((t) => t.str)
                .join(" ")
                .trim();
              if (secLabel)
                currentSection = sec.str.trim() + " " + secLabel;
            }
          }

          const band = allTexts.filter((t) => t.y >= anchor.y && t.y < nextY);

          const description = band
            .filter((t) => t.x >= DESC_X_MIN && t.x < DESC_X_MAX)
            .map((t) => t.str)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();

          const unit = band
            .filter((t) => t.x >= UNIT_X_MIN && t.x < UNIT_X_MAX)
            .map((t) => t.str)
            .join("")
            .trim();

          const qty = band
            .filter((t) => t.x >= QTY_X_MIN)
            .map((t) => t.str)
            .join("")
            .trim();

          if (description) {
            items.push({ item_no: anchor.item_no, description, unit, qty, section: currentSection });
          }
        }

        resolve(items);
      } catch (err) {
        reject(err);
      }
    });

    parser.loadPDF(filePath);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF PARSER — Lodha style
//
// Lodha BOQ columns:
//   SR.No | Item Description | HSN/SAC Code | Unit | Qty | Rate | Amount
//
// Layout heuristic based on the Lodha work order PDF:
//   sr_no        : x < 3
//   description  : 3 ≤ x < 28
//   hsn          : 28 ≤ x < 33
//   unit         : 33 ≤ x < 36
//   qty          : 36 ≤ x < 40
//   rate         : 40 ≤ x < 47
//   amount       : x ≥ 47
// ─────────────────────────────────────────────────────────────────────────────
function parseLodhaBoqPdf(filePath) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, 1);

    parser.on("pdfParser_dataError", (err) =>
      reject(new Error("PDF parse error: " + err))
    );

    parser.on("pdfParser_dataReady", (data) => {
      try {
        const pages = data.Pages || [];
        const allTexts = [];

        for (let pi = 0; pi < pages.length; pi++) {
          const yOffset = pi * 10000;
          for (const text of pages[pi].Texts || []) {
            allTexts.push({
              x: parseFloat(text.x.toFixed(3)),
              y: parseFloat(text.y.toFixed(3)) + yOffset,
              str: text.R.map((r) => safeDecode(r.T)).join(""),
            });
          }
        }

        allTexts.sort((a, b) => a.y - b.y || a.x - b.x);

        // Column boundaries (tuned for Lodha WO format)
        const COL = {
          SR_MAX:   3,
          DESC_MIN: 3,   DESC_MAX:  28,
          HSN_MIN:  28,  HSN_MAX:   33,
          UNIT_MIN: 33,  UNIT_MAX:  36,
          QTY_MIN:  36,  QTY_MAX:   40,
          RATE_MIN: 40,  RATE_MAX:  47,
          AMT_MIN:  47,
        };

        // Row anchors: numeric or dotted-numeric SR numbers on the left (e.g. "1", "1.01", "1.01.1")
        const rowAnchors = allTexts
          .filter((t) => /^[\d]+(?:\.\d+)*$/.test(t.str.trim()) && t.x < COL.SR_MAX)
          .map((t) => ({ sr_no: t.str.trim(), y: t.y }));

        const items = [];

        for (let i = 0; i < rowAnchors.length; i++) {
          const anchor = rowAnchors[i];
          const nextY = i + 1 < rowAnchors.length ? rowAnchors[i + 1].y : anchor.y + 20;

          const band = allTexts.filter((t) => t.y >= anchor.y && t.y < nextY);

          const pickCol = (xMin, xMax) =>
            band
              .filter((t) => t.x >= xMin && (xMax === undefined || t.x < xMax))
              .map((t) => t.str)
              .join(" ")
              .replace(/\s+/g, " ")
              .trim();

          const item_description = pickCol(COL.DESC_MIN, COL.DESC_MAX);
          const hsn              = pickCol(COL.HSN_MIN,  COL.HSN_MAX);
          const unit             = pickCol(COL.UNIT_MIN, COL.UNIT_MAX);
          const qty              = pickCol(COL.QTY_MIN,  COL.QTY_MAX);
          const rate             = pickCol(COL.RATE_MIN, COL.RATE_MAX);
          const amount           = pickCol(COL.AMT_MIN,  undefined);

          if (item_description) {
            items.push({
              sr_no: anchor.sr_no,
              item_description,
              hsn,
              unit,
              qty,
              rate,
              amount,
            });
          }
        }

        resolve(items);
      } catch (err) {
        reject(err);
      }
    });

    parser.loadPDF(filePath);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF PARSER — Hiranandani style
//
// Hiranandani Work Order columns:
//   Sr No | Service Description | Order Qty | UOM | Unit Price | Value
//
// Layout heuristic based on the Hiranandani WO PDF:
//   sr_no        : x < 4
//   description  : 4 ≤ x < 28
//   order_qty    : 28 ≤ x < 33
//   uom          : 33 ≤ x < 37
//   unit_price   : 37 ≤ x < 44
//   value        : x ≥ 44
// ─────────────────────────────────────────────────────────────────────────────
function parseHiranandaniBoqPdf(filePath) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, 1);

    parser.on("pdfParser_dataError", (err) =>
      reject(new Error("PDF parse error: " + err))
    );

    parser.on("pdfParser_dataReady", (data) => {
      try {
        const pages = data.Pages || [];
        const allTexts = [];

        for (let pi = 0; pi < pages.length; pi++) {
          const yOffset = pi * 10000;
          for (const text of pages[pi].Texts || []) {
            allTexts.push({
              x: parseFloat(text.x.toFixed(3)),
              y: parseFloat(text.y.toFixed(3)) + yOffset,
              str: text.R.map((r) => safeDecode(r.T)).join(""),
            });
          }
        }

        allTexts.sort((a, b) => a.y - b.y || a.x - b.x);

        // Column boundaries (tuned for Hiranandani WO format)
        const COL = {
          SR_MAX:   4,
          DESC_MIN: 4,   DESC_MAX:  28,
          QTY_MIN:  28,  QTY_MAX:   33,
          UOM_MIN:  33,  UOM_MAX:   37,
          PRICE_MIN:37,  PRICE_MAX: 44,
          VALUE_MIN:44,
        };

        // Row anchors: parenthesised numbers like (1), (2) or plain integers
        const rowAnchors = allTexts
          .filter((t) => {
            const s = t.str.trim();
            return (
              (/^\(\d+\)$/.test(s) || /^\d+$/.test(s)) && t.x < COL.SR_MAX
            );
          })
          .map((t) => ({
            sr_no: t.str.trim().replace(/[()]/g, ""),
            y: t.y,
          }));

        // Also detect section headers — lines where description contains "Building :"
        // They will be attached to items as `section`
        const sectionTexts = allTexts.filter((t) =>
          t.str.includes("Building") || t.str.includes("Plumbing") || t.str.includes("Geberit")
        );

        const items = [];
        let currentSection = null;

        for (let i = 0; i < rowAnchors.length; i++) {
          const anchor = rowAnchors[i];
          const nextY = i + 1 < rowAnchors.length ? rowAnchors[i + 1].y : anchor.y + 30;

          // Check if a section header appears just before this anchor
          const prevY = i > 0 ? rowAnchors[i - 1].y : 0;
          for (const st of sectionTexts) {
            if (st.y >= prevY && st.y < anchor.y) {
              currentSection = st.str.trim();
            }
          }

          const band = allTexts.filter((t) => t.y >= anchor.y && t.y < nextY);

          const pickCol = (xMin, xMax) =>
            band
              .filter((t) => t.x >= xMin && (xMax === undefined || t.x < xMax))
              .map((t) => t.str)
              .join(" ")
              .replace(/\s+/g, " ")
              .trim();

          const service_description = pickCol(COL.DESC_MIN, COL.DESC_MAX);
          const order_qty           = pickCol(COL.QTY_MIN,  COL.QTY_MAX);
          const uom                 = pickCol(COL.UOM_MIN,  COL.UOM_MAX);
          const unit_price          = pickCol(COL.PRICE_MIN,COL.PRICE_MAX);
          const value               = pickCol(COL.VALUE_MIN, undefined);

          // Skip CGST/SGST tax rows and empty rows
          if (
            !service_description ||
            service_description.toUpperCase().includes("CGST") ||
            service_description.toUpperCase().includes("SGST")
          ) continue;

          items.push({
            sr_no: anchor.sr_no,
            service_description,
            order_qty,
            uom,
            unit_price,
            value,
            section: currentSection,
          });
        }

        resolve(items);
      } catch (err) {
        reject(err);
      }
    });

    parser.loadPDF(filePath);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SWAGGER SCHEMAS
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * components:
 *   schemas:
 *     BOQ:
 *       type: object
 *       properties:
 *         boq_id:
 *           type: integer
 *         category:
 *           type: string
 *         item_code:
 *           type: string
 *         description:
 *           type: string
 *         floor:
 *           type: string
 *         unit:
 *           type: string
 *         quantity:
 *           type: number
 *         rate:
 *           type: number
 *         amount:
 *           type: number
 *         boq_file:
 *           type: string
 *         project_id:
 *           type: integer
 *         project_name:
 *           type: string
 *         created_at:
 *           type: string
 *           format: date-time
 *
 *     BOQItem:
 *       type: object
 *       properties:
 *         item_no:
 *           type: string
 *           example: "1"
 *         description:
 *           type: string
 *         unit:
 *           type: string
 *           example: "Nos."
 *         qty:
 *           type: string
 *           example: "396.00"
 *         section:
 *           type: string
 *           nullable: true
 *
 *     LodhaBoqItem:
 *       type: object
 *       properties:
 *         sr_no:
 *           type: string
 *           example: "1.01.1"
 *         item_description:
 *           type: string
 *         hsn:
 *           type: string
 *           example: "995468"
 *         unit:
 *           type: string
 *           example: "SET"
 *         qty:
 *           type: string
 *           example: "1.000"
 *         rate:
 *           type: string
 *           example: "186000.00"
 *         amount:
 *           type: string
 *           example: "186000.00"
 *
 *     HiranandaniBoqItem:
 *       type: object
 *       properties:
 *         sr_no:
 *           type: string
 *           example: "1"
 *         service_description:
 *           type: string
 *         order_qty:
 *           type: string
 *           example: "340"
 *         uom:
 *           type: string
 *           example: "NOS"
 *         unit_price:
 *           type: string
 *           example: "522.50"
 *         value:
 *           type: string
 *           example: "177650.00"
 *         section:
 *           type: string
 *           nullable: true
 */

// ════════════════════════════════════════════════════════════════════════════
// POST /api/boq  — Create a BOQ item (generic)
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/boq:
 *   post:
 *     summary: Create a new BOQ item (generic)
 *     tags: [BOQ]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               category:
 *                 type: string
 *               item_code:
 *                 type: string
 *               description:
 *                 type: string
 *               floor:
 *                 type: string
 *               unit:
 *                 type: string
 *               quantity:
 *                 type: number
 *               rate:
 *                 type: number
 *               amount:
 *                 type: number
 *               project_id:
 *                 type: integer
 *               project_name:
 *                 type: string
 *               boq_file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: BOQ created
 *       400:
 *         description: Invalid project_id
 *       500:
 *         description: Server error
 */
router.post("/", upload.single("boq_file"), async (req, res) => {
  try {
    const {
      category, item_code, description, floor,
      unit, quantity, rate, amount, project_id, project_name
    } = req.body;

    const boq_file = req.file ? `/uploads/boq/${req.file.filename}` : null;

    const result = await pool.query(
      `INSERT INTO boqs
         (category, item_code, description, floor, unit, quantity, rate, amount, boq_file, project_id, project_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [category, item_code, description, floor, unit, quantity, rate, amount, boq_file, project_id, project_name]
    );

    res.status(201).json(result.rows[0]);

    logActivity({
      action: "created",
      entity_type: "boq",
      entity_id: result.rows[0].boq_id,
      entity_name: description || item_code || `BOQ #${result.rows[0].boq_id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id,
      meta: { item_code, quantity, amount },
    });
  } catch (err) {
    console.error("Error creating BOQ:", err);
    if (err.code === "23503")
      return res.status(400).json({ error: "Invalid project_id: Project does not exist" });
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/boq/lodha  — Create a Lodha BOQ item
//
// Lodha fields: item_description, hsn, unit, qty, rate, amount
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/boq/lodha:
 *   post:
 *     summary: Create a Lodha BOQ item
 *     description: |
 *       Creates a BOQ entry using the **Lodha** work order field layout:
 *       `item_description`, `hsn`, `unit`, `qty`, `rate`, `amount`.
 *
 *       These are mapped internally to the `boqs` table as:
 *       - item_description → description
 *       - hsn → item_code
 *       - qty → quantity
 *     tags: [BOQ]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - item_description
 *               - project_id
 *             properties:
 *               item_description:
 *                 type: string
 *                 description: Item description as per Lodha BOQ
 *               hsn:
 *                 type: string
 *                 description: HSN/SAC code
 *               unit:
 *                 type: string
 *                 description: Unit of measurement (e.g. SET, NOS, RMT)
 *               qty:
 *                 type: number
 *                 description: Quantity
 *               rate:
 *                 type: number
 *                 description: Rate per unit
 *               amount:
 *                 type: number
 *                 description: Total amount (qty × rate)
 *               project_id:
 *                 type: integer
 *                 description: Project ID (required)
 *               project_name:
 *                 type: string
 *               category:
 *                 type: string
 *               floor:
 *                 type: string
 *               boq_file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: Lodha BOQ item created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 boq_id:
 *                   type: integer
 *                 client:
 *                   type: string
 *                   example: lodha
 *                 item_description:
 *                   type: string
 *                 hsn:
 *                   type: string
 *                 unit:
 *                   type: string
 *                 qty:
 *                   type: number
 *                 rate:
 *                   type: number
 *                 amount:
 *                   type: number
 *                 project_id:
 *                   type: integer
 *       400:
 *         description: Missing required fields or invalid project_id
 *       500:
 *         description: Server error
 */
router.post("/lodha", upload.single("boq_file"), async (req, res) => {
  try {
    const {
      item_description, hsn, unit, qty, rate, amount,
      project_id, project_name, category, floor,
    } = req.body;

    if (!item_description) {
      return res.status(400).json({ error: "item_description is required" });
    }
    if (!project_id) {
      return res.status(400).json({ error: "project_id is required" });
    }

    const boq_file = req.file ? `/uploads/boq/${req.file.filename}` : null;

    const result = await pool.query(
      `INSERT INTO boqs
         (category, item_code, description, floor, unit, quantity, rate, amount, boq_file, project_id, project_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        category || null,
        hsn || null,           // hsn → item_code
        item_description,      // item_description → description
        floor || null,
        unit || null,
        parseFloat(qty) || 0,  // qty → quantity
        parseFloat(rate) || 0,
        parseFloat(amount) || 0,
        boq_file,
        parseInt(project_id),
        project_name || null,
      ]
    );

    const row = result.rows[0];

    res.status(201).json({
      boq_id:           row.boq_id,
      client:           "lodha",
      item_description: row.description,
      hsn:              row.item_code,
      unit:             row.unit,
      qty:              row.quantity,
      rate:             row.rate,
      amount:           row.amount,
      project_id:       row.project_id,
      project_name:     row.project_name,
      category:         row.category,
      floor:            row.floor,
      boq_file:         row.boq_file,
      created_at:       row.created_at,
    });

    logActivity({
      action: "created",
      entity_type: "boq",
      entity_id: row.boq_id,
      entity_name: item_description || `Lodha BOQ #${row.boq_id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id,
      meta: { client: "lodha", hsn, qty, amount },
    });
  } catch (err) {
    console.error("Error creating Lodha BOQ:", err);
    if (err.code === "23503")
      return res.status(400).json({ error: "Invalid project_id: Project does not exist" });
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/boq/hiranandani  — Create a Hiranandani BOQ item
//
// Hiranandani fields: service_description, order_qty, uom, unit_price, value
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/boq/hiranandani:
 *   post:
 *     summary: Create a Hiranandani BOQ item
 *     description: |
 *       Creates a BOQ entry using the **Hiranandani** work order field layout:
 *       `service_description`, `order_qty`, `uom`, `unit_price`, `value`.
 *
 *       These are mapped internally to the `boqs` table as:
 *       - service_description → description
 *       - order_qty → quantity
 *       - uom → unit
 *       - unit_price → rate
 *       - value → amount
 *     tags: [BOQ]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - service_description
 *               - project_id
 *             properties:
 *               service_description:
 *                 type: string
 *                 description: Service description as per Hiranandani work order
 *               order_qty:
 *                 type: number
 *                 description: Order quantity
 *               uom:
 *                 type: string
 *                 description: Unit of measurement (e.g. NOS, AU, M)
 *               unit_price:
 *                 type: number
 *                 description: Unit price
 *               value:
 *                 type: number
 *                 description: Total value (order_qty × unit_price)
 *               project_id:
 *                 type: integer
 *                 description: Project ID (required)
 *               project_name:
 *                 type: string
 *               category:
 *                 type: string
 *               floor:
 *                 type: string
 *               boq_file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: Hiranandani BOQ item created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 boq_id:
 *                   type: integer
 *                 client:
 *                   type: string
 *                   example: hiranandani
 *                 service_description:
 *                   type: string
 *                 order_qty:
 *                   type: number
 *                 uom:
 *                   type: string
 *                 unit_price:
 *                   type: number
 *                 value:
 *                   type: number
 *                 project_id:
 *                   type: integer
 *       400:
 *         description: Missing required fields or invalid project_id
 *       500:
 *         description: Server error
 */
router.post("/hiranandani", upload.single("boq_file"), async (req, res) => {
  try {
    const {
      service_description, order_qty, uom, unit_price, value,
      project_id, project_name, category, floor,
    } = req.body;

    if (!service_description) {
      return res.status(400).json({ error: "service_description is required" });
    }
    if (!project_id) {
      return res.status(400).json({ error: "project_id is required" });
    }

    const boq_file = req.file ? `/uploads/boq/${req.file.filename}` : null;

    const result = await pool.query(
      `INSERT INTO boqs
         (category, item_code, description, floor, unit, quantity, rate, amount, boq_file, project_id, project_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        category || null,
        null,                         // no HSN in Hiranandani format
        service_description,          // service_description → description
        floor || null,
        uom || null,                  // uom → unit
        parseFloat(order_qty) || 0,   // order_qty → quantity
        parseFloat(unit_price) || 0,  // unit_price → rate
        parseFloat(value) || 0,       // value → amount
        boq_file,
        parseInt(project_id),
        project_name || null,
      ]
    );

    const row = result.rows[0];

    res.status(201).json({
      boq_id:              row.boq_id,
      client:              "hiranandani",
      service_description: row.description,
      order_qty:           row.quantity,
      uom:                 row.unit,
      unit_price:          row.rate,
      value:               row.amount,
      project_id:          row.project_id,
      project_name:        row.project_name,
      category:            row.category,
      floor:               row.floor,
      boq_file:            row.boq_file,
      created_at:          row.created_at,
    });

    logActivity({
      action: "created",
      entity_type: "boq",
      entity_id: row.boq_id,
      entity_name: service_description || `Hiranandani BOQ #${row.boq_id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id,
      meta: { client: "hiranandani", order_qty, unit_price, value },
    });
  } catch (err) {
    console.error("Error creating Hiranandani BOQ:", err);
    if (err.code === "23503")
      return res.status(400).json({ error: "Invalid project_id: Project does not exist" });
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/boq  — All BOQ records
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/boq:
 *   get:
 *     summary: Get all BOQ items
 *     tags: [BOQ]
 *     responses:
 *       200:
 *         description: List of all BOQs
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/BOQ'
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM boqs ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching BOQs:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/boq/items  — item_no, description, unit, qty for ALL records
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/boq/items:
 *   get:
 *     summary: Get all BOQ items as clean JSON (item_no, description, unit, qty)
 *     tags: [BOQ]
 *     responses:
 *       200:
 *         description: Clean item list
 */
router.get("/items", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT boq_id, item_code AS item_no, description, unit, quantity AS qty, project_id, project_name
       FROM boqs
       ORDER BY boq_id ASC`
    );
    res.json({ total: result.rowCount, items: result.rows });
  } catch (err) {
    console.error("Error fetching BOQ items:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/boq/parse-pdf  — Generic BOQ PDF parser (original)
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/boq/parse-pdf:
 *   post:
 *     summary: Parse a generic BOQ PDF and get all items as JSON
 *     description: |
 *       Parses a BOQ PDF using **pdf2json** (pure Node.js, no Python needed).
 *       Returns `item_no`, `description`, `unit`, `qty`, `section` for every line item.
 *       Pass `project_id` + `save=true` to bulk-insert parsed items into the `boqs` table.
 *     tags: [BOQ]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - boq_file
 *             properties:
 *               boq_file:
 *                 type: string
 *                 format: binary
 *               project_id:
 *                 type: integer
 *               save:
 *                 type: string
 *                 enum: ["true","false"]
 *                 default: "false"
 *               category:
 *                 type: string
 *     responses:
 *       200:
 *         description: Parsed items
 *       400:
 *         description: No file uploaded
 *       500:
 *         description: Parse error
 */
router.post("/parse-pdf", upload.single("boq_file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No BOQ PDF file uploaded" });
  }

  const filePath = path.join(uploadDir, req.file.filename);
  const { project_id, save, category } = req.body;
  const shouldSave = save === "true" || save === true;

  try {
    const parsedItems = await parseBOQPdfNpm(filePath);
    let savedCount = 0;

    if (shouldSave && project_id) {
      const sql = `
        INSERT INTO boqs (category, item_code, description, unit, quantity, boq_file, project_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `;
      for (const item of parsedItems) {
        await pool.query(sql, [
          category || item.section || null,
          item.item_no,
          item.description,
          item.unit,
          parseFloat(item.qty) || 0,
          `/uploads/boq/${req.file.filename}`,
          parseInt(project_id),
        ]);
        savedCount++;
      }

      logActivity({
        action: "created",
        entity_type: "boq",
        entity_id: null,
        entity_name: `BOQ PDF Import — ${req.file.originalname}`,
        performed_by: req.body.user_id || null,
        performed_by_name: req.body.user_name || null,
        project_id,
        meta: { items_imported: savedCount, filename: req.file.originalname },
      });
    }

    return res.json({
      total: parsedItems.length,
      saved: shouldSave && !!project_id,
      saved_count: savedCount,
      project_id: project_id ? parseInt(project_id) : null,
      file: `/uploads/boq/${req.file.filename}`,
      items: parsedItems,
    });
  } catch (err) {
    console.error("BOQ PDF parse error:", err);
    return res.status(500).json({ error: err.message || "Failed to parse BOQ PDF" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/boq/parse-pdf/lodha  — Parse a Lodha Work Order PDF
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/boq/parse-pdf/lodha:
 *   post:
 *     summary: Parse a Lodha Work Order PDF and extract BOQ items
 *     description: |
 *       Parses a **Lodha** format Work Order PDF (Cowtown Infotech / Lodha style).
 *
 *       Extracts per-line: `sr_no`, `item_description`, `hsn`, `unit`, `qty`, `rate`, `amount`.
 *
 *       Pass `project_id` + `save=true` to bulk-insert items into the `boqs` table.
 *     tags: [BOQ]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - boq_file
 *             properties:
 *               boq_file:
 *                 type: string
 *                 format: binary
 *                 description: Lodha Work Order PDF
 *               project_id:
 *                 type: integer
 *                 description: Required when save=true
 *               save:
 *                 type: string
 *                 enum: ["true","false"]
 *                 default: "false"
 *               category:
 *                 type: string
 *                 description: Optional category tag for saved items
 *     responses:
 *       200:
 *         description: Parsed Lodha BOQ items
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 client:
 *                   type: string
 *                   example: lodha
 *                 total:
 *                   type: integer
 *                 saved:
 *                   type: boolean
 *                 saved_count:
 *                   type: integer
 *                 project_id:
 *                   type: integer
 *                   nullable: true
 *                 file:
 *                   type: string
 *                 items:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/LodhaBoqItem'
 *       400:
 *         description: No file uploaded
 *       500:
 *         description: Parse error
 */
router.post("/parse-pdf/lodha", upload.single("boq_file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No BOQ PDF file uploaded" });
  }

  const filePath = path.join(uploadDir, req.file.filename);
  const { project_id, save, category } = req.body;
  const shouldSave = save === "true" || save === true;

  try {
    const parsedItems = await parseLodhaBoqPdf(filePath);
    let savedCount = 0;

    if (shouldSave && project_id) {
      const sql = `
        INSERT INTO boqs (category, item_code, description, unit, quantity, rate, amount, boq_file, project_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `;
      for (const item of parsedItems) {
        await pool.query(sql, [
          category || null,
          item.hsn || null,
          item.item_description,
          item.unit || null,
          parseFloat(item.qty)    || 0,
          parseFloat(item.rate)   || 0,
          parseFloat(item.amount) || 0,
          `/uploads/boq/${req.file.filename}`,
          parseInt(project_id),
        ]);
        savedCount++;
      }

      logActivity({
        action: "created",
        entity_type: "boq",
        entity_id: null,
        entity_name: `Lodha BOQ PDF Import — ${req.file.originalname}`,
        performed_by: req.body.user_id || null,
        performed_by_name: req.body.user_name || null,
        project_id,
        meta: { client: "lodha", items_imported: savedCount, filename: req.file.originalname },
      });
    }

    return res.json({
      client: "lodha",
      total: parsedItems.length,
      saved: shouldSave && !!project_id,
      saved_count: savedCount,
      project_id: project_id ? parseInt(project_id) : null,
      file: `/uploads/boq/${req.file.filename}`,
      items: parsedItems,
    });
  } catch (err) {
    console.error("Lodha BOQ PDF parse error:", err);
    return res.status(500).json({ error: err.message || "Failed to parse Lodha BOQ PDF" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/boq/parse-pdf/hiranandani  — Parse a Hiranandani Work Order PDF
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/boq/parse-pdf/hiranandani:
 *   post:
 *     summary: Parse a Hiranandani Work Order PDF and extract BOQ items
 *     description: |
 *       Parses a **Hiranandani** format Work Order PDF (HGP Community Pvt. Ltd. style).
 *
 *       Extracts per-line: `sr_no`, `service_description`, `order_qty`, `uom`,
 *       `unit_price`, `value`, `section`.
 *
 *       CGST/SGST tax rows are automatically skipped.
 *
 *       Pass `project_id` + `save=true` to bulk-insert items into the `boqs` table.
 *     tags: [BOQ]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - boq_file
 *             properties:
 *               boq_file:
 *                 type: string
 *                 format: binary
 *                 description: Hiranandani Work Order PDF
 *               project_id:
 *                 type: integer
 *                 description: Required when save=true
 *               save:
 *                 type: string
 *                 enum: ["true","false"]
 *                 default: "false"
 *               category:
 *                 type: string
 *                 description: Optional category tag for saved items
 *     responses:
 *       200:
 *         description: Parsed Hiranandani BOQ items
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 client:
 *                   type: string
 *                   example: hiranandani
 *                 total:
 *                   type: integer
 *                 saved:
 *                   type: boolean
 *                 saved_count:
 *                   type: integer
 *                 project_id:
 *                   type: integer
 *                   nullable: true
 *                 file:
 *                   type: string
 *                 items:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/HiranandaniBoqItem'
 *       400:
 *         description: No file uploaded
 *       500:
 *         description: Parse error
 */
router.post("/parse-pdf/hiranandani", upload.single("boq_file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No BOQ PDF file uploaded" });
  }

  const filePath = path.join(uploadDir, req.file.filename);
  const { project_id, save, category } = req.body;
  const shouldSave = save === "true" || save === true;

  try {
    const parsedItems = await parseHiranandaniBoqPdf(filePath);
    let savedCount = 0;

    if (shouldSave && project_id) {
      const sql = `
        INSERT INTO boqs (category, description, unit, quantity, rate, amount, boq_file, project_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `;
      for (const item of parsedItems) {
        await pool.query(sql, [
          category || item.section || null,
          item.service_description,
          item.uom || null,
          parseFloat(item.order_qty)   || 0,
          parseFloat(item.unit_price)  || 0,
          parseFloat(item.value)       || 0,
          `/uploads/boq/${req.file.filename}`,
          parseInt(project_id),
        ]);
        savedCount++;
      }

      logActivity({
        action: "created",
        entity_type: "boq",
        entity_id: null,
        entity_name: `Hiranandani BOQ PDF Import — ${req.file.originalname}`,
        performed_by: req.body.user_id || null,
        performed_by_name: req.body.user_name || null,
        project_id,
        meta: { client: "hiranandani", items_imported: savedCount, filename: req.file.originalname },
      });
    }

    return res.json({
      client: "hiranandani",
      total: parsedItems.length,
      saved: shouldSave && !!project_id,
      saved_count: savedCount,
      project_id: project_id ? parseInt(project_id) : null,
      file: `/uploads/boq/${req.file.filename}`,
      items: parsedItems,
    });
  } catch (err) {
    console.error("Hiranandani BOQ PDF parse error:", err);
    return res.status(500).json({ error: err.message || "Failed to parse Hiranandani BOQ PDF" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/boq/project/:projectId  — Full BOQ for a project (with summary)
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/boq/project/{projectId}:
 *   get:
 *     summary: Get all BOQ records for a project, including total_amount summary
 *     tags: [BOQ]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: BOQs for the project
 *       404:
 *         description: No BOQ items found for this project
 */
router.get("/project/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;
    const result = await pool.query(
      "SELECT * FROM boqs WHERE project_id = $1 ORDER BY boq_id ASC",
      [projectId]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "No BOQ items found for this project" });

    const totalAmount = result.rows.reduce(
      (sum, r) => sum + (parseFloat(r.amount) || 0), 0
    );

    res.json({
      project_id: parseInt(projectId),
      total_items: result.rowCount,
      total_amount: parseFloat(totalAmount.toFixed(2)),
      boqs: result.rows,
    });
  } catch (err) {
    console.error("Error fetching project BOQs:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/boq/project/:projectId/items  — Slim items list for a project
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/boq/project/{projectId}/items:
 *   get:
 *     summary: Get item_no, description, unit, qty for a project
 *     tags: [BOQ]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Slim item list
 *       404:
 *         description: No BOQ items found for this project
 */
router.get("/project/:projectId/items", async (req, res) => {
  try {
    const { projectId } = req.params;
    const result = await pool.query(
      `SELECT boq_id, item_code AS item_no, description, unit, quantity AS qty
       FROM boqs WHERE project_id = $1 ORDER BY boq_id ASC`,
      [projectId]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "No BOQ items found for this project" });

    res.json({
      project_id: parseInt(projectId),
      total: result.rowCount,
      items: result.rows,
    });
  } catch (err) {
    console.error("Error fetching project BOQ items:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/boq/:id  — Single BOQ record
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/boq/{id}:
 *   get:
 *     summary: Get a BOQ item by ID
 *     tags: [BOQ]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: BOQ item
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/BOQ'
 *       404:
 *         description: BOQ not found
 */
router.get("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM boqs WHERE boq_id = $1",
      [req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "BOQ not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching BOQ:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PUT /api/boq/:id  — Update a BOQ item (dynamic fields)
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/boq/{id}:
 *   put:
 *     summary: Update a BOQ item
 *     tags: [BOQ]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               category:
 *                 type: string
 *               item_code:
 *                 type: string
 *               description:
 *                 type: string
 *               floor:
 *                 type: string
 *               unit:
 *                 type: string
 *               quantity:
 *                 type: number
 *               rate:
 *                 type: number
 *               amount:
 *                 type: number
 *               project_id:
 *                 type: integer
 *               boq_file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Updated BOQ
 *       400:
 *         description: No fields to update
 *       404:
 *         description: BOQ not found
 */
router.put("/:id", upload.single("boq_file"), async (req, res) => {
  try {
    const { id } = req.params;
    const FIELDS = [
      "category", "item_code", "description", "floor",
      "unit", "quantity", "rate", "amount", "project_id",
    ];

    const sets = [];
    const vals = [];
    let n = 1;

    for (const f of FIELDS) {
      if (req.body[f] !== undefined) {
        sets.push(`${f} = $${n++}`);
        vals.push(req.body[f]);
      }
    }

    if (req.file) {
      sets.push(`boq_file = $${n++}`);
      vals.push(`/uploads/boq/${req.file.filename}`);
    }

    if (sets.length === 0)
      return res.status(400).json({ error: "No fields to update" });

    vals.push(id);
    const result = await pool.query(
      `UPDATE boqs SET ${sets.join(", ")} WHERE boq_id = $${n} RETURNING *`,
      vals
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "BOQ not found" });

    res.json(result.rows[0]);

    logActivity({
      action: "updated",
      entity_type: "boq",
      entity_id: id,
      entity_name: result.rows[0].description || result.rows[0].item_code,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: result.rows[0].project_id,
      meta: { updates: req.body },
    });
  } catch (err) {
    console.error("Error updating BOQ:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// DELETE /api/boq/:id  — Delete a BOQ item
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/boq/{id}:
 *   delete:
 *     summary: Delete a BOQ item
 *     tags: [BOQ]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Deleted successfully
 *       404:
 *         description: BOQ not found
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const check = await pool.query(
      "SELECT boq_file FROM boqs WHERE boq_id = $1",
      [id]
    );
    if (check.rows.length === 0)
      return res.status(404).json({ error: "BOQ not found" });

    const fileUrl = check.rows[0].boq_file;
    if (fileUrl) {
      const fp = path.join(uploadDir, path.basename(fileUrl));
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }

    const del = await pool.query(
      "DELETE FROM boqs WHERE boq_id = $1 RETURNING *",
      [id]
    );

    res.json({ message: "BOQ deleted successfully", boq_id: parseInt(id) });

    logActivity({
      action: "deleted",
      entity_type: "boq",
      entity_id: id,
      entity_name: del.rows[0]?.description || `BOQ #${id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: del.rows[0]?.project_id,
      meta: {},
    });
  } catch (err) {
    console.error("Error deleting BOQ:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;