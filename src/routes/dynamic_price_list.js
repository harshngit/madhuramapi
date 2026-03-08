/**
 * routes/dynamic_price_list.js
 * ─────────────────────────────
 * AI-powered dynamic price list extractor.
 * Accepts ANY vendor's PDF or Excel file — no fixed template required.
 * Uses Claude AI to intelligently identify columns, categories, item codes,
 * sizes, prices, and HSN codes regardless of layout or format.
 *
 * Endpoints:
 *   POST /api/dynamic-price-list/extract   — PDF or Excel → structured JSON
 *   POST /api/dynamic-price-list/search    — PDF or Excel → search filtered results
 */

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const { extractPriceListFromPDF } = require("../utils/pdfExtractor");

const router = express.Router();

// ─── Upload directory ─────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, "../../uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ─── Multer: accept PDF, XLS, XLSX — 30MB max ────────────────────────────────
const ALLOWED_MIMETYPES = [
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];
const ALLOWED_EXTENSIONS = [".pdf", ".xls", ".xlsx"];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `dynpl-${unique}${path.extname(file.originalname).toLowerCase()}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_MIMETYPES.includes(file.mimetype) || ALLOWED_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, XLS, or XLSX files are allowed"), false);
    }
  },
  limits: { fileSize: 30 * 1024 * 1024 },
});

function cleanup(filePath) {
  if (filePath && fs.existsSync(filePath)) fs.unlink(filePath, () => {});
}

// ─── Extract raw text from Excel (any format) ────────────────────────────────
function extractExcelText(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheets = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

    // Convert rows to readable text
    const textLines = rows
      .filter((row) => row.some((cell) => cell !== "" && cell !== null))
      .map((row) => row.map((cell) => String(cell).trim()).join("\t"));

    sheets.push({
      sheetName,
      rowCount: rows.length,
      text: textLines.join("\n"),
    });
  }

  return sheets;
}

// ─── Call Claude AI to extract structured data ────────────────────────────────

// ─── OCR extraction using pdfjs-dist + tesseract.js (zero system dependencies) ──
async function extractTextWithOCR(filePath, totalPages) {
  const { createWorker } = require("tesseract.js");
  const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
  const { createCanvas } = require("@napi-rs/canvas");
  const fsLib = require("fs");

  const pdfBuffer = fsLib.readFileSync(filePath);
  const pdfDoc = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/",
  }).promise;

  const maxPages = Math.min(totalPages, 30);
  const worker = await createWorker("eng");
  let allText = "";

  try {
    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      try {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 2.0 }); // scale 2x for better OCR

        // Create canvas using @napi-rs/canvas (already in your package.json)
        const canvas = createCanvas(viewport.width, viewport.height);
        const ctx = canvas.getContext("2d");

        await page.render({
          canvasContext: ctx,
          viewport,
        }).promise;

        // Convert canvas to PNG buffer
        const imgBuffer = canvas.toBuffer("image/png");

        // OCR the buffer directly
        const { data: { text } } = await worker.recognize(imgBuffer);
        allText += `\n\n=== PAGE ${pageNum} ===\n` + text;
        page.cleanup();
      } catch (e) {
        console.warn(`OCR skipped page ${pageNum}: ${e.message}`);
      }
    }
  } finally {
    await worker.terminate();
  }

  return allText.trim() || "No text extracted via OCR";
}

// Call Gemini API with a single chunk of text
async function callGeminiAPI(prompt, apiKey) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 8192,
          responseMimeType: "application/json",
        },
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const rawJson = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

  if (!rawJson) throw new Error("Gemini returned empty response");

  let cleaned = rawJson.trim();
  cleaned = cleaned.replace(/^```(?:json)?[\r\n]*/i, "").replace(/[\r\n]*```\s*$/i, "").trim();
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1) cleaned = cleaned.slice(firstBrace, lastBrace + 1);

  return JSON.parse(cleaned);
}

async function extractWithAI(rawText, sourceType, vendorHint = "") {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set in environment variables");

  // Split by page markers (from OCR) or into safe 5-page groups
  // This prevents cutting mid-sentence which breaks JSON
  const pageMarkerRegex = /(?====\s*PAGE\s*\d+\s*===)/i;
  let pages = rawText.split(pageMarkerRegex).filter(p => p.trim().length > 20);

  // If no page markers, split into groups of 5000 chars at paragraph boundaries
  if (pages.length <= 1) {
    pages = [];
    let remaining = rawText;
    while (remaining.length > 0) {
      let cutAt = Math.min(5000, remaining.length);
      // Try to cut at a newline boundary
      if (cutAt < remaining.length) {
        const lastNewline = remaining.lastIndexOf("\n", cutAt);
        if (lastNewline > 2000) cutAt = lastNewline;
      }
      pages.push(remaining.slice(0, cutAt));
      remaining = remaining.slice(cutAt);
    }
  }

  // Group pages into batches of 3 pages each (~safe size for Gemini output)
  const PAGES_PER_BATCH = 3;
  const batches = [];
  for (let i = 0; i < pages.length; i += PAGES_PER_BATCH) {
    batches.push(pages.slice(i, i + PAGES_PER_BATCH).join("\n"));
  }

  console.log(`Processing ${batches.length} batches from ${pages.length} pages, ${rawText.length} total chars`);

  const makePrompt = (text) => `You are a price list extraction engine. Return ONLY a JSON array of items. No other text.

Format — respond with ONLY this, nothing else:
[
  {
    "item_code": "IS 1",
    "category": "BRONZE GATE VALVE",
    "product_name": "Sant Bronze Gate Valve Class-1 Screwed Non-Rising Stem",
    "size": "1/2",
    "size_mm": "15",
    "price": 1505,
    "hsn_code": "84818030",
    "unit": "Pc"
  }
]

Rules:
- Return ONLY the JSON array [ ... ] — no object wrapper, no markdown
- Each size+price row = one item
- price = number not string
- If zero items found, return empty array: []
- item_code from labels: IS 1, IS 6, SBM 1, IBR 1A, CS 1 etc near each product block
- category from section headings e.g. BRONZE GATE VALVE, CAST IRON VALVE
- product_name from "Product :" line
${vendorHint ? `- Vendor hint: ${vendorHint}` : ""}

Text:
${text}`;

  const allItems = [];
  let vendorName = vendorHint || null;
  let priceListDate = null;

  // Extract vendor name and date from first batch only
  const headerPrompt = `Extract ONLY vendor name and date from this text. Return ONLY JSON object like:
{"vendor_name": "SANT Valves Pvt Ltd", "price_list_date": "11.01.2026"}
If not found return: {"vendor_name": null, "price_list_date": null}

Text: ${pages.slice(0, 2).join("\n").slice(0, 2000)}`;

  try {
    const headerResult = await callGeminiAPI(headerPrompt, apiKey);
    if (headerResult.vendor_name) vendorName = headerResult.vendor_name;
    if (headerResult.price_list_date) priceListDate = headerResult.price_list_date;
  } catch (e) {
    console.warn("Header extraction failed:", e.message);
  }

  // Process batches sequentially to avoid rate limits
  for (let i = 0; i < batches.length; i++) {
    try {
      const prompt = makePrompt(batches[i]);
      const raw = await callGeminiRaw(prompt, apiKey);

      // Parse array response
      let cleaned = raw.trim();
      cleaned = cleaned.replace(/^```(?:json)?[\r\n]*/i, "").replace(/[\r\n]*```\s*$/i, "").trim();

      // Extract array [ ... ]
      const firstBracket = cleaned.indexOf("[");
      const lastBracket = cleaned.lastIndexOf("]");
      if (firstBracket !== -1 && lastBracket !== -1) {
        cleaned = cleaned.slice(firstBracket, lastBracket + 1);
      }

      const items = JSON.parse(cleaned);
      if (Array.isArray(items)) {
        allItems.push(...items.filter(item => item && item.product_name));
        console.log(`Batch ${i + 1}/${batches.length}: extracted ${items.length} items`);
      }
    } catch (err) {
      console.warn(`Batch ${i + 1} failed:`, err.message);
    }

    // Delay between batches to respect rate limits
    if (i < batches.length - 1) await new Promise(r => setTimeout(r, 800));
  }

  console.log(`Total items extracted: ${allItems.length}`);

  return {
    vendor_name: vendorName,
    price_list_date: priceListDate,
    currency: "INR",
    total_items_extracted: allItems.length,
    categories: [...new Set(allItems.map(i => i.category).filter(Boolean))],
    items: allItems,
  };
}

// Raw Gemini call that returns text string
async function callGeminiRaw(prompt, apiKey) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 8192,
          responseMimeType: "application/json",
        },
      }),
    }
  );
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) throw new Error("Gemini returned empty response");
  return text;
}


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/dynamic-price-list/extract
// Upload any vendor PDF or Excel → AI returns structured JSON
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/dynamic-price-list/extract:
 *   post:
 *     summary: "AI-powered: Extract price list from ANY vendor PDF or Excel"
 *     description: |
 *       Upload any vendor's price list in PDF or Excel format.
 *       Claude AI automatically detects the layout, column structure, item codes,
 *       categories, sizes, prices, and HSN codes — no fixed template required.
 *
 *       Supported file types: PDF, XLS, XLSX (max 30MB)
 *       Field name: `file`
 *     tags: [Dynamic Price List]
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
 *                 description: "PDF, XLS, or XLSX price list file (max 30MB)"
 *               vendor_hint:
 *                 type: string
 *                 description: "Optional vendor name hint e.g. SANT Valves - improves AI accuracy"
 *               category_filter:
 *                 type: string
 *                 description: "Filter results by category keyword e.g. BRONZE or CAST IRON"
 *               sheet_name:
 *                 type: string
 *                 description: "Excel only - filter to a specific sheet name (default: all sheets)"
 *     responses:
 *       200:
 *         description: Price list extracted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 filename:
 *                   type: string
 *                 file_type:
 *                   type: string
 *                   enum: [pdf, excel]
 *                 vendor_name:
 *                   type: string
 *                 price_list_date:
 *                   type: string
 *                 currency:
 *                   type: string
 *                 summary:
 *                   type: object
 *                 items:
 *                   type: array
 *       400:
 *         description: No file uploaded or invalid file type
 *       500:
 *         description: Extraction failed
 */
router.post("/extract", upload.single("file"), async (req, res) => {
  if (!req.file)
    return res.status(400).json({
      success: false,
      error: "No file uploaded. Use field name 'file'. Accepted: PDF, XLS, XLSX",
    });

  const ext = path.extname(req.file.originalname).toLowerCase();
  const isExcel = ext === ".xlsx" || ext === ".xls";
  const isPDF = ext === ".pdf";
  const vendorHint = (req.body.vendor_hint || "").trim();
  const categoryFilter = (req.body.category_filter || "").trim().toUpperCase();
  // Ignore Swagger UI placeholder values
  const effectiveCategoryFilter = (categoryFilter === "STRING" || categoryFilter === "") ? "" : categoryFilter;
  const sheetNameFilter = (req.body.sheet_name || "").trim();

  try {
    let rawText = "";
    let sourceType = "";
    let pageCount = null;
    let sheetsSummary = null;

    if (isPDF) {
      sourceType = "PDF price list";
      const result = await extractPriceListFromPDF(req.file.path);
      pageCount = result.totalPages;

      // Detect if PDF has real price table data or just image-based content
      // A proper price list text layer should have: product names, HSN codes, size+price patterns
      const rawExtracted = result.rawText;
      const hasPricePatterns = /\d+[\.\/\d]*\s+\d+\s+\d{3,}/m.test(rawExtracted);   // e.g. "1/2 15 1796"
      const hasProductKeywords = /product|hsn|valve|pipe|fitting|price|rate/i.test(rawExtracted);
      const hasItemCodes = /\b(IS|SBM|IBR|CS|FSV|IC|FBV|WM|CI|CR)\s*\d+/i.test(rawExtracted);
      const isRealTextPDF = hasPricePatterns || (hasProductKeywords && hasItemCodes);

      if (!isRealTextPDF) {
        // PDF is image-based — use OCR
        console.log("PDF appears image-based (no price patterns found), switching to OCR...");
        rawText = await extractTextWithOCR(req.file.path, pageCount);
        sourceType = "OCR-scanned PDF price list";
      } else {
        rawText = rawExtracted;
      }
    } else if (isExcel) {
      sourceType = "Excel spreadsheet price list";
      const sheets = extractExcelText(req.file.path);

      // Filter by sheet name if requested
      const targetSheets = sheetNameFilter
        ? sheets.filter((s) => s.sheetName.toLowerCase().includes(sheetNameFilter.toLowerCase()))
        : sheets;

      rawText = targetSheets.map((s) => `=== SHEET: ${s.sheetName} ===\n${s.text}`).join("\n\n");
      sheetsSummary = sheets.map((s) => ({ sheetName: s.sheetName, rowCount: s.rowCount }));
    } else {
      cleanup(req.file.path);
      return res.status(400).json({ success: false, error: "Unsupported file type" });
    }

    cleanup(req.file.path);

    if (!rawText || rawText.trim().length < 20) {
      return res.status(400).json({ success: false, error: "Could not extract any text from the file" });
    }

    // Call Claude AI
    const extracted = await extractWithAI(rawText, sourceType, vendorHint);

    // Apply category filter if specified (ignore Swagger placeholder "string")
    let items = extracted.items || [];
    if (effectiveCategoryFilter) {
      items = items.filter(
        (item) =>
          (item.category || "").toUpperCase().includes(effectiveCategoryFilter) ||
          (item.product_name || "").toUpperCase().includes(effectiveCategoryFilter)
      );
    }

    // Build category breakdown
    const categoryMap = {};
    for (const item of items) {
      const cat = item.category || "UNCATEGORIZED";
      if (!categoryMap[cat]) categoryMap[cat] = 0;
      categoryMap[cat]++;
    }

    const prices = items.map((i) => i.price).filter((p) => typeof p === "number" && p > 0);

    return res.json({
      success: true,
      filename: req.file.originalname,
      file_type: isPDF ? "pdf" : "excel",
      vendor_name: extracted.vendor_name || vendorHint || null,
      price_list_date: extracted.price_list_date || null,
      currency: extracted.currency || "INR",
      summary: {
        total_items: items.length,
        total_categories: Object.keys(categoryMap).length,
        categories: Object.keys(categoryMap),
        category_breakdown: categoryMap,
        price_range: prices.length
          ? { min: Math.min(...prices), max: Math.max(...prices) }
          : null,
        ...(pageCount !== null && { total_pages: pageCount }),
        ...(sheetsSummary && { sheets: sheetsSummary }),
        ...(effectiveCategoryFilter && { applied_filter: effectiveCategoryFilter }),
      },
      items,
    });
  } catch (error) {
    cleanup(req.file?.path);
    console.error("Dynamic extract error:", error);

    if (error.message?.includes("JSON")) {
      return res.status(500).json({
        success: false,
        error: "AI returned malformed JSON. Try again or reduce file size.",
        detail: error.message,
      });
    }

    return res.status(500).json({ success: false, error: "Extraction failed", detail: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/dynamic-price-list/search
// Upload any vendor file + search query → AI-extracted filtered results
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/dynamic-price-list/search:
 *   post:
 *     summary: "AI-powered: Search within any vendor's price list PDF or Excel"
 *     description: |
 *       Upload any vendor's price list and search for specific products.
 *       Claude AI extracts ALL items first, then filters by your search query.
 *       Matches against: item_code, product_name, category, size, hsn_code.
 *     tags: [Dynamic Price List]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file, query]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               query:
 *                 type: string
 *                 description: "Search term e.g. gate valve, IS 1, 1 inch, or HSN code 84815"
 *               vendor_hint:
 *                 type: string
 *               min_price:
 *                 type: number
 *               max_price:
 *                 type: number
 *     responses:
 *       200:
 *         description: Search results
 *       400:
 *         description: Missing file or query
 */
router.post("/search", upload.single("file"), async (req, res) => {
  if (!req.file)
    return res.status(400).json({ success: false, error: "No file uploaded. Use field name 'file'." });

  const query = (req.body.query || "").trim();
  if (!query)
    return res.status(400).json({ success: false, error: "Search 'query' is required in form body." });

  const vendorHint = (req.body.vendor_hint || "").trim();
  const minPrice = req.body.min_price ? parseFloat(req.body.min_price) : null;
  const maxPrice = req.body.max_price ? parseFloat(req.body.max_price) : null;

  const ext = path.extname(req.file.originalname).toLowerCase();
  const isExcel = ext === ".xlsx" || ext === ".xls";
  const isPDF = ext === ".pdf";

  try {
    let rawText = "";

    if (isPDF) {
      const result = await extractPriceListFromPDF(req.file.path);
      const _raw2 = result.rawText;
      const _hasPrice2 = /\d+[\.\/\d]*\s+\d+\s+\d{3,}/m.test(_raw2);
      const _hasKeywords2 = /product|hsn|valve|pipe|fitting/i.test(_raw2);
      rawText = (_hasPrice2 || _hasKeywords2)
        ? _raw2
        : await extractTextWithOCR(req.file.path, result.totalPages);
    } else if (isExcel) {
      const sheets = extractExcelText(req.file.path);
      rawText = sheets.map((s) => `=== SHEET: ${s.sheetName} ===\n${s.text}`).join("\n\n");
    } else {
      cleanup(req.file.path);
      return res.status(400).json({ success: false, error: "Unsupported file type" });
    }

    cleanup(req.file.path);

    const extracted = await extractWithAI(rawText, isPDF ? "PDF" : "Excel", vendorHint);
    let items = extracted.items || [];

    // Search filter: match across all text fields
    const q = query.toLowerCase();
    items = items.filter((item) => {
      return (
        (item.item_code || "").toLowerCase().includes(q) ||
        (item.product_name || "").toLowerCase().includes(q) ||
        (item.category || "").toLowerCase().includes(q) ||
        (item.size || "").toLowerCase().includes(q) ||
        (item.size_mm || "").toString().includes(q) ||
        (item.hsn_code || "").toString().includes(q)
      );
    });

    // Price range filter
    if (minPrice !== null) items = items.filter((i) => typeof i.price === "number" && i.price >= minPrice);
    if (maxPrice !== null) items = items.filter((i) => typeof i.price === "number" && i.price <= maxPrice);

    return res.json({
      success: true,
      filename: req.file.originalname,
      file_type: isPDF ? "pdf" : "excel",
      vendor_name: extracted.vendor_name || vendorHint || null,
      query,
      filters: { min_price: minPrice, max_price: maxPrice },
      total_matches: items.length,
      items,
    });
  } catch (error) {
    cleanup(req.file?.path);
    console.error("Dynamic search error:", error);
    return res.status(500).json({ success: false, error: "Search failed", detail: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/dynamic-price-list/compare
// Upload TWO price list files → AI compares prices for matching items
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/dynamic-price-list/compare:
 *   post:
 *     summary: "AI-powered: Compare prices between two vendor price lists"
 *     description: |
 *       Upload two different vendor price lists (PDF or Excel).
 *       Claude AI extracts both, matches items by name/code/size, and returns
 *       a comparison showing price differences.
 *
 *       Field names: `file1`, `file2`
 *     tags: [Dynamic Price List]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file1, file2]
 *             properties:
 *               file1:
 *                 type: string
 *                 format: binary
 *               file2:
 *                 type: string
 *                 format: binary
 *               vendor1_name:
 *                 type: string
 *               vendor2_name:
 *                 type: string
 *     responses:
 *       200:
 *         description: Comparison results
 */
const uploadTwo = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) cb(null, true);
    else cb(new Error("Only PDF, XLS, XLSX allowed"), false);
  },
  limits: { fileSize: 30 * 1024 * 1024 },
}).fields([
  { name: "file1", maxCount: 1 },
  { name: "file2", maxCount: 1 },
]);

router.post("/compare", async (req, res) => {
  // Handle multipart upload manually for Express 5 compatibility
  await new Promise((resolve, reject) => {
    uploadTwo(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  }).catch((err) => {
    return res.status(400).json({ success: false, error: err.message });
  });
  if (res.headersSent) return;
  const f1 = req.files?.file1?.[0];
  const f2 = req.files?.file2?.[0];

  if (!f1 || !f2) {
    cleanup(f1?.path); cleanup(f2?.path);
    return res.status(400).json({ success: false, error: "Two files required: 'file1' and 'file2'" });
  }

  const vendor1Name = (req.body.vendor1_name || f1.originalname).trim();
  const vendor2Name = (req.body.vendor2_name || f2.originalname).trim();

  try {
    // Extract both files
    async function extractFile(file, hint) {
      const ext = path.extname(file.originalname).toLowerCase();
      let rawText = "";
      if (ext === ".pdf") {
        const result = await extractPriceListFromPDF(file.path);
        const _rawC = result.rawText;
        const _hasPriceC = /\d+[\.\/\d]*\s+\d+\s+\d{3,}/m.test(_rawC);
        const _hasKwC = /product|hsn|valve|pipe|fitting/i.test(_rawC);
        rawText = (_hasPriceC || _hasKwC)
          ? _rawC
          : await extractTextWithOCR(file.path, result.totalPages);
      } else {
        const sheets = extractExcelText(file.path);
        rawText = sheets.map((s) => `=== SHEET: ${s.sheetName} ===\n${s.text}`).join("\n\n");
      }
      cleanup(file.path);
      return extractWithAI(rawText, ext === ".pdf" ? "PDF" : "Excel", hint);
    }

    const [data1, data2] = await Promise.all([
      extractFile(f1, vendor1Name),
      extractFile(f2, vendor2Name),
    ]);

    const items1 = data1.items || [];
    const items2 = data2.items || [];

    // Match items by item_code or product_name similarity
    const matched = [];
    const onlyInVendor1 = [];
    const onlyInVendor2 = [];

    const used2 = new Set();

    for (const item1 of items1) {
      const key1 = (item1.item_code || item1.product_name || "").toLowerCase().trim();
      const size1 = (item1.size || item1.size_mm || "").toString().toLowerCase();

      let bestMatch = null;
      let bestScore = 0;

      for (let i = 0; i < items2.length; i++) {
        if (used2.has(i)) continue;
        const item2 = items2[i];
        const key2 = (item2.item_code || item2.product_name || "").toLowerCase().trim();
        const size2 = (item2.size || item2.size_mm || "").toString().toLowerCase();

        // Score: exact code match = 2, name contains = 1, size match bonus
        let score = 0;
        if (key1 && key2 && key1 === key2) score += 2;
        else if (key1 && key2 && (key1.includes(key2) || key2.includes(key1))) score += 1;
        if (size1 && size2 && size1 === size2) score += 1;

        if (score > bestScore) {
          bestScore = score;
          bestMatch = { item: item2, index: i };
        }
      }

      if (bestMatch && bestScore >= 1) {
        used2.add(bestMatch.index);
        const p1 = item1.price;
        const p2 = bestMatch.item.price;
        const diff = typeof p1 === "number" && typeof p2 === "number" ? p2 - p1 : null;

        matched.push({
          item_code: item1.item_code || bestMatch.item.item_code,
          product_name: item1.product_name,
          category: item1.category,
          size: item1.size,
          [vendor1Name]: { price: p1, unit: item1.unit },
          [vendor2Name]: { price: p2, unit: bestMatch.item.unit },
          price_difference: diff,
          cheaper_vendor: diff === null ? null : diff < 0 ? vendor1Name : diff > 0 ? vendor2Name : "same",
        });
      } else {
        onlyInVendor1.push(item1);
      }
    }

    for (let i = 0; i < items2.length; i++) {
      if (!used2.has(i)) onlyInVendor2.push(items2[i]);
    }

    return res.json({
      success: true,
      vendor1: { name: vendor1Name, total_items: items1.length, date: data1.price_list_date },
      vendor2: { name: vendor2Name, total_items: items2.length, date: data2.price_list_date },
      summary: {
        matched_items: matched.length,
        only_in_vendor1: onlyInVendor1.length,
        only_in_vendor2: onlyInVendor2.length,
        vendor1_cheaper_count: matched.filter((m) => m.cheaper_vendor === vendor1Name).length,
        vendor2_cheaper_count: matched.filter((m) => m.cheaper_vendor === vendor2Name).length,
      },
      comparison: matched,
      only_in_vendor1: onlyInVendor1,
      only_in_vendor2: onlyInVendor2,
    });
  } catch (error) {
    cleanup(f1?.path); cleanup(f2?.path);
    console.error("Compare error:", error);
    return res.status(500).json({ success: false, error: "Comparison failed", detail: error.message });
  }
});

module.exports = router;