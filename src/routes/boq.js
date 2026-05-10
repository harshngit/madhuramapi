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
// PDF PARSER  (pure npm — no Python needed)
//
// npm install:  npm install pdf2json
//
// Strategy:
//   1. Flatten every page's text elements into a single Y-coordinate space.
//   2. Identify "item anchor" rows — numeric item numbers in the left column (x < 6.5).
//   3. For each anchor, collect ALL text between its Y and the next anchor's Y.
//   4. Assign that text to columns by X range:
//        item_no  :  x < 6.5
//        description : 6.5 ≤ x < 27.5
//        unit        : 27.5 ≤ x < 30.5
//        qty         : x ≥ 30.5
// ─────────────────────────────────────────────────────────────────────────────
function parseBOQPdfNpm(filePath) {
  return new Promise((resolve, reject) => {
    function safeDecode(s) {
      try { return decodeURIComponent(s); } catch (_) { return s; }
    }

    const parser = new PDFParser(null, 1); // 2nd arg suppresses verbose logs

    parser.on("pdfParser_dataError", (err) =>
      reject(new Error("PDF parse error: " + err))
    );

    parser.on("pdfParser_dataReady", (data) => {
      try {
        const pages = data.Pages || [];
        const allTexts = [];

        // Add a large per-page Y offset so rows never collide across pages
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

        // Column X boundaries (determined by analysing the Oakwood BOQ layout)
        const ITEM_X_MAX = 6.5;
        const DESC_X_MIN = 6.5;
        const DESC_X_MAX = 27.5;
        const UNIT_X_MIN = 27.5;
        const UNIT_X_MAX = 30.5;
        const QTY_X_MIN  = 30.5;

        // Item-number anchors: numeric strings in the left column
        const itemAnchors = allTexts
          .filter((t) => /^\d+$/.test(t.str.trim()) && t.x < ITEM_X_MAX)
          .map((t) => ({ item_no: t.str.trim(), y: t.y }));

        // Section header anchors: "A.", "B.", … in the left column
        const sectionAnchors = allTexts.filter(
          (t) => /^[A-Z]\.$/.test(t.str.trim()) && t.x < 7
        );

        const items = [];
        let currentSection = null;

        for (let i = 0; i < itemAnchors.length; i++) {
          const anchor = itemAnchors[i];
          const nextY =
            i + 1 < itemAnchors.length
              ? itemAnchors[i + 1].y
              : anchor.y + 20;

          // Update section if a section header falls between the previous
          // item anchor and this one
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

          // Collect all text in the vertical band owned by this item
          const band = allTexts.filter(
            (t) => t.y >= anchor.y && t.y < nextY
          );

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
            items.push({
              item_no: anchor.item_no,
              description,
              unit,
              qty,
              section: currentSection,
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
 *           example: "A. SANITARY FIXTURES & FITTINGS (INSTALLATION)"
 */

// ════════════════════════════════════════════════════════════════════════════
// POST /api/boq  — Create a BOQ item
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/boq:
 *   post:
 *     summary: Create a new BOQ item
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
 *     description: Returns only the four key fields for every BOQ record in the database.
 *     tags: [BOQ]
 *     responses:
 *       200:
 *         description: Clean item list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total:
 *                   type: integer
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       boq_id:
 *                         type: integer
 *                       item_no:
 *                         type: string
 *                       description:
 *                         type: string
 *                       unit:
 *                         type: string
 *                       qty:
 *                         type: number
 *                       project_id:
 *                         type: integer
 *                       project_name:
 *                         type: string
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
// POST /api/boq/parse-pdf  — Parse BOQ PDF → JSON  (NO Python needed)
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/boq/parse-pdf:
 *   post:
 *     summary: Upload a BOQ PDF and get all items as JSON
 *     description: |
 *       Parses a BOQ PDF using **pdf2json** — a pure Node.js library, no Python required.
 *
 *       Returns every line item's `item_no`, `description`, `unit`, `qty` and `section`.
 *
 *       Pass `project_id` + `save=true` to also bulk-insert the parsed items into the
 *       `boqs` table.
 *
 *       **One-time setup:** `npm install pdf2json`
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
 *                 description: BOQ PDF to parse
 *               project_id:
 *                 type: integer
 *                 description: Required when save=true
 *               save:
 *                 type: string
 *                 enum: ["true", "false"]
 *                 default: "false"
 *                 description: Set "true" to persist items to the database
 *               category:
 *                 type: string
 *                 description: Optional category tag for saved items
 *     responses:
 *       200:
 *         description: Parsed items
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
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
 *                     $ref: '#/components/schemas/BOQItem'
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
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 project_id:
 *                   type: integer
 *                 total_items:
 *                   type: integer
 *                 total_amount:
 *                   type: number
 *                 boqs:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/BOQ'
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
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 project_id:
 *                   type: integer
 *                 total:
 *                   type: integer
 *                 items:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/BOQItem'
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

    // Remove physical file if present
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