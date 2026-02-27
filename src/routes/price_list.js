/**
 * routes/price_list.js
 * ─────────────────────
 * PDF Price List extraction API.
 * Supports: Supreme SERENE / SERENE PLUS / SWR / CPVC / SkyRise / uPVC / Agriculture
 *           Atam Valves price lists — and any tabular PDF price list.
 */

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const {
  extractPriceListFromPDF,
  parsePriceRows,
  groupByCategory,
} = require("../utils/pdfExtractor");

const router = express.Router();

// ─── Upload directory ─────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, "../../uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ─── Multer config (PDF only, 20MB max) ──────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `pricelist-${unique}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are allowed"), false);
  },
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ─── Helper ───────────────────────────────────────────────────────────────────
function cleanup(filePath) {
  if (filePath && fs.existsSync(filePath)) fs.unlink(filePath, () => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/price-list/extract-text
// Returns raw page-by-page text (lightweight, no parsing)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/price-list/extract-text:
 *   post:
 *     summary: Extract raw text from a price list PDF (page by page)
 *     tags: [Price List]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [pdf]
 *             properties:
 *               pdf:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Text extracted successfully
 */
router.post("/extract-text", upload.single("pdf"), async (req, res) => {
  if (!req.file)
    return res.status(400).json({ success: false, error: "No PDF file uploaded. Use field name 'pdf'." });

  try {
    const result = await extractPriceListFromPDF(req.file.path);
    cleanup(req.file.path);

    return res.json({
      success: true,
      filename: req.file.originalname,
      totalPages: result.totalPages,
      rawText: result.rawText,
      pages: result.pages,
    });
  } catch (error) {
    cleanup(req.file.path);
    console.error("PDF text extraction error:", error);
    return res.status(500).json({ success: false, error: "Failed to extract text from PDF" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/price-list/extract-table
// Returns structured rows + grouped-by-category table view
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/price-list/extract-table:
 *   post:
 *     summary: Extract structured price table rows from a PDF (with category grouping)
 *     description: |
 *       Returns two views:
 *       1. `priceData` — flat array of all rows with itemName, prices (mapped to column headers), values
 *       2. `groupedData` — rows grouped by detected product category (SERENE, SWR, CPVC etc.)
 *     tags: [Price List]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [pdf]
 *             properties:
 *               pdf:
 *                 type: string
 *                 format: binary
 *               category_filter:
 *                 type: string
 *                 description: "Optional keyword filter on item name (e.g: PIPE, BEND, VALVE)"
 *     responses:
 *       200:
 *         description: Price table extracted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 filename:
 *                   type: string
 *                 totalPages:
 *                   type: integer
 *                 totalRows:
 *                   type: integer
 *                 categories:
 *                   type: array
 *                   description: List of detected product categories in this PDF
 *                   items:
 *                     type: string
 *                   example: ["SERENE", "SWR", "CPVC"]
 *                 groupedData:
 *                   type: object
 *                   description: Rows grouped by category
 *                   example:
 *                     SERENE:
 *                       category: "SERENE"
 *                       columns: ["25", "32", "40", "50", "75", "110"]
 *                       items:
 *                         - itemName: "87.5° Bend"
 *                           prices: { "25": "74", "32": "150", "40": "337" }
 *                 priceData:
 *                   type: array
 *                   description: Flat list of all rows
 *                   items:
 *                     type: object
 *                     properties:
 *                       category:
 *                         type: string
 *                       itemName:
 *                         type: string
 *                       prices:
 *                         type: object
 *                         description: Size/column label mapped to price value
 *                         example: { "25": "74", "32": "150", "40": "337" }
 *                       values:
 *                         type: array
 *                         items:
 *                           type: string
 *                       rawLine:
 *                         type: string
 */
router.post("/extract-table", upload.single("pdf"), async (req, res) => {
  if (!req.file)
    return res.status(400).json({ success: false, error: "No PDF file uploaded. Use field name 'pdf'." });

  const categoryFilter = (req.body.category_filter || "").trim();

  try {
    const result = await extractPriceListFromPDF(req.file.path);
    cleanup(req.file.path);

    const priceData = parsePriceRows(result.rawText, categoryFilter);
    const groupedData = groupByCategory(priceData);
    const categories = Object.keys(groupedData);

    return res.json({
      success: true,
      filename: req.file.originalname,
      totalPages: result.totalPages,
      categoryFilter: categoryFilter || "ALL",
      totalRows: priceData.length,
      categories,          // ["SERENE", "SWR", "CPVC", ...]
      groupedData,         // { SERENE: { columns, items }, SWR: { ... } }
      priceData,           // flat array with category + prices object
    });
  } catch (error) {
    cleanup(req.file.path);
    console.error("PDF table extraction error:", error);
    return res.status(500).json({ success: false, error: "Failed to extract price table from PDF" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/price-list/search
// Search for item by name across all categories
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/price-list/search:
 *   post:
 *     summary: Search for a specific item in a price list PDF
 *     description: |
 *       Upload a PDF and search for any item by name.
 *       Returns all matching rows with category, mapped column prices, and raw values.
 *     tags: [Price List]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [pdf, item_name]
 *             properties:
 *               pdf:
 *                 type: string
 *                 format: binary
 *               item_name:
 *                 type: string
 *                 example: "Gate Valve"
 *     responses:
 *       200:
 *         description: Search completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 filename:
 *                   type: string
 *                 searchQuery:
 *                   type: string
 *                 matchCount:
 *                   type: integer
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       category:
 *                         type: string
 *                       itemName:
 *                         type: string
 *                       prices:
 *                         type: object
 *                         example: { "25": "74", "32": "150" }
 *                       values:
 *                         type: array
 *                       rawLine:
 *                         type: string
 */
router.post("/search", upload.single("pdf"), async (req, res) => {
  if (!req.file)
    return res.status(400).json({ success: false, error: "No PDF file uploaded. Use field name 'pdf'." });

  const itemName = (req.body.item_name || "").trim();
  if (!itemName) {
    cleanup(req.file.path);
    return res.status(400).json({ success: false, error: "item_name is required" });
  }

  try {
    const result = await extractPriceListFromPDF(req.file.path);
    cleanup(req.file.path);

    const allRows = parsePriceRows(result.rawText, "");
    const matches = allRows.filter((row) =>
      row.itemName.toLowerCase().includes(itemName.toLowerCase())
    );

    return res.json({
      success: true,
      filename: req.file.originalname,
      searchQuery: itemName,
      matchCount: matches.length,
      results: matches, // includes category + prices object
    });
  } catch (error) {
    cleanup(req.file.path);
    console.error("PDF search error:", error);
    return res.status(500).json({ success: false, error: "Failed to search PDF" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/price-list/extract-by-page
// Extract text and price rows from a specific page
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/price-list/extract-by-page:
 *   post:
 *     summary: Extract text from a specific page of a price list PDF
 *     tags: [Price List]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [pdf, page_number]
 *             properties:
 *               pdf:
 *                 type: string
 *                 format: binary
 *               page_number:
 *                 type: integer
 *                 example: 1
 *     responses:
 *       200:
 *         description: Page extracted successfully
 */
router.post("/extract-by-page", upload.single("pdf"), async (req, res) => {
  if (!req.file)
    return res.status(400).json({ success: false, error: "No PDF file uploaded. Use field name 'pdf'." });

  const pageNumber = parseInt(req.body.page_number, 10);
  if (!pageNumber || pageNumber < 1) {
    cleanup(req.file.path);
    return res.status(400).json({ success: false, error: "page_number must be a positive integer" });
  }

  try {
    const result = await extractPriceListFromPDF(req.file.path);
    cleanup(req.file.path);

    if (pageNumber > result.totalPages) {
      return res.status(404).json({
        success: false,
        error: `Page ${pageNumber} not found. PDF has ${result.totalPages} pages.`,
      });
    }

    const page = result.pages.find((p) => p.pageNumber === pageNumber);
    const priceRows = parsePriceRows(page.text, "");
    const groupedData = groupByCategory(priceRows);

    return res.json({
      success: true,
      filename: req.file.originalname,
      totalPages: result.totalPages,
      requestedPage: pageNumber,
      text: page.text,
      totalRows: priceRows.length,
      categories: Object.keys(groupedData),
      groupedData,
      priceRows,
    });
  } catch (error) {
    cleanup(req.file.path);
    console.error("PDF page extraction error:", error);
    return res.status(500).json({ success: false, error: "Failed to extract page from PDF" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/price-list/smart-extract
// NEW: All-in-one smart endpoint — returns full structured table auto-detected
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/price-list/smart-extract:
 *   post:
 *     summary: Smart auto-detection — returns full structured price table with categories and mapped prices
 *     description: |
 *       Best endpoint to use. Uploads any price list PDF and returns:
 *       - Detected product categories (SERENE, SWR, CPVC, ATAM etc.)
 *       - Column headers (sizes like 25mm, 32mm, 40mm...)
 *       - Each item with prices mapped to column headers
 *       - Summary statistics
 *     tags: [Price List]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [pdf]
 *             properties:
 *               pdf:
 *                 type: string
 *                 format: binary
 *               item_filter:
 *                 type: string
 *                 description: Optional item name filter
 *               category_filter:
 *                 type: string
 *                 description: Optional category filter (e.g. SERENE, SWR, CPVC)
 *     responses:
 *       200:
 *         description: Smart extraction complete
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 filename:
 *                   type: string
 *                 totalPages:
 *                   type: integer
 *                 summary:
 *                   type: object
 *                   properties:
 *                     totalCategories:
 *                       type: integer
 *                     totalItems:
 *                       type: integer
 *                     categories:
 *                       type: array
 *                       items:
 *                         type: string
 *                 table:
 *                   type: object
 *                   description: Full grouped price table
 */
router.post("/smart-extract", upload.single("pdf"), async (req, res) => {
  if (!req.file)
    return res.status(400).json({ success: false, error: "No PDF file uploaded. Use field name 'pdf'." });

  const itemFilter = (req.body.item_filter || "").trim();
  const categoryFilter = (req.body.category_filter || "").trim().toUpperCase();

  try {
    const result = await extractPriceListFromPDF(req.file.path);
    cleanup(req.file.path);

    const allRows = parsePriceRows(result.rawText, itemFilter);

    // Apply category filter if provided
    const filteredRows = categoryFilter
      ? allRows.filter((r) => r.category.toUpperCase().includes(categoryFilter))
      : allRows;

    const groupedData = groupByCategory(filteredRows);
    const categories = Object.keys(groupedData);

    return res.json({
      success: true,
      filename: req.file.originalname,
      totalPages: result.totalPages,
      filters: {
        itemFilter: itemFilter || null,
        categoryFilter: categoryFilter || null,
      },
      summary: {
        totalCategories: categories.length,
        totalItems: filteredRows.length,
        categories,
        // Per-category item count
        categoryStats: categories.map((cat) => ({
          category: cat,
          itemCount: groupedData[cat].items.length,
          columns: groupedData[cat].columns,
        })),
      },
      table: groupedData, // Full structured table
    });
  } catch (error) {
    cleanup(req.file.path);
    console.error("Smart extract error:", error);
    return res.status(500).json({ success: false, error: "Failed to smart-extract from PDF" });
  }
});

module.exports = router;