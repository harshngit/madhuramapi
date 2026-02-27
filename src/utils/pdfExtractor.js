/**
 * utils/pdfExtractor.js
 * ─────────────────────
 * Extracts text from PDF price list files.
 * Uses pdfjs-dist to extract raw text content page-by-page,
 * with smart column header detection and category grouping.
 */

const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const fs = require("fs");

/**
 * Extract all text from a PDF file, page by page.
 * @param {string} filePath - Path to the PDF file
 * @returns {Promise<{ totalPages: number, rawText: string, pages: Array<{pageNumber: number, text: string}> }>}
 */
async function extractPriceListFromPDF(filePath) {
  const inputBuffer = fs.readFileSync(filePath);

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(inputBuffer),
    standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/",
  });

  const pdfDocument = await loadingTask.promise;
  const totalPages = pdfDocument.numPages;
  const pages = [];

  for (let i = 1; i <= totalPages; i++) {
    const page = await pdfDocument.getPage(i);
    const textContent = await page.getTextContent();

    // Reconstruct lines by tracking Y position changes
    let lastY = null;
    let pageText = "";

    for (const item of textContent.items) {
      const currentY = item.transform ? item.transform[5] : null;

      if (lastY !== null && currentY !== null && Math.abs(currentY - lastY) > 2) {
        pageText += "\n";
      }

      pageText += item.str + " ";
      lastY = currentY;
    }

    pages.push({
      pageNumber: i,
      text: pageText.trim(),
    });

    page.cleanup();
  }

  const rawText = pages.map((p) => p.text).join("\n\n--- PAGE BREAK ---\n\n");

  return { totalPages, rawText, pages };
}

// ─── Size/column header patterns ─────────────────────────────────────────────
// Matches things like: 25, 32, 40, 50mm  OR  1/2", 3/4"  OR  110, 160 (SWR sizes)
const SIZE_PATTERNS = [
  /^\d{2,3}\s*mm$/i,          // 25mm, 110mm
  /^\d{2,3}$/,                // bare numbers used as size cols (32, 40, 50...)
  /^\d+\/\d+"?$/,             // 1/2", 3/4"
  /^(dn\s*)?\d{2,3}$/i,       // DN25, DN32
];

/**
 * Check if a token looks like a column size header
 */
function isSizeToken(token) {
  const t = token.replace(/mm$/i, "").replace(/"/g, "").trim();
  return SIZE_PATTERNS.some((p) => p.test(token)) || /^\d{2,3}(mm)?$/.test(token);
}

/**
 * Detect column headers (sizes) from lines that consist mostly of size-like tokens.
 * Returns array of size labels or null if line doesn't look like a header.
 */
function detectColumnHeaders(line) {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;

  // Common header keywords
  const HEADER_KEYWORDS = /^(size|mm|dn|dia|diameter|description|item|sr\.?\s*no|mrp|rs\.?|price|rate)$/i;

  const sizeTokens = tokens.filter((t) => isSizeToken(t));
  const keywordTokens = tokens.filter((t) => HEADER_KEYWORDS.test(t));

  // If more than half the tokens are size-like OR it has keyword + sizes → it's a header
  if (sizeTokens.length >= 2 || (keywordTokens.length >= 1 && sizeTokens.length >= 1)) {
    // Return only the size tokens as column labels
    return sizeTokens.length > 0 ? sizeTokens : null;
  }

  return null;
}

/**
 * Detect product category from a line (e.g. "SUPREME SERENE PP", "SWR PIPES", "CPVC")
 */
function detectCategory(line) {
  const upper = line.toUpperCase();

  const CATEGORIES = [
    { key: "SERENE_PLUS", pattern: /SERENE\s*PLUS/ },
    { key: "SERENE", pattern: /SERENE/ },
    { key: "SWR", pattern: /\bSWR\b/ },
    { key: "CPVC", pattern: /\bCPVC\b/ },
    { key: "UPVC", pattern: /\bUPVC\b/ },
    { key: "SKYRISE", pattern: /\bSKYRISE\b/ },
    { key: "AGRICULTURE", pattern: /\bAGRICULTURE\b|\bAGRI\b/ },
    { key: "ATAM_VALVES", pattern: /\bATAM\b|\bVALVE[S]?\b/ },
    { key: "COLUMN_PIPE", pattern: /\bCOLUMN\s*PIPE\b/ },
    { key: "CASING_PIPE", pattern: /\bCASING\s*PIPE\b/ },
  ];

  for (const cat of CATEGORIES) {
    if (cat.pattern.test(upper)) return cat.key;
  }

  // Generic: if line is ALL CAPS and short, treat as a section header
  if (/^[A-Z0-9 \-\/\.]{3,50}$/.test(line.trim()) && line.trim().length < 50) {
    const trimmed = line.trim();
    // Avoid treating price rows as categories
    if (!/\d{3,}/.test(trimmed)) return trimmed;
  }

  return null;
}

/**
 * Parse structured price rows from extracted raw text.
 * Returns rows grouped by category with column headers mapped to values.
 *
 * @param {string} rawText
 * @param {string} filterKeyword - Optional keyword to filter by item name
 * @returns {Array<{ category: string, itemName: string, prices: Object, values: string[], rawLine: string }>}
 */
function parsePriceRows(rawText, filterKeyword = "") {
  const rows = [];
  const lines = rawText.split("\n");
  const keyword = filterKeyword.toUpperCase().trim();

  let currentCategory = "GENERAL";
  let currentColumns = []; // detected size/column headers

  const skipPatterns = [
    /^-{3,}/,         // --- PAGE BREAK ---
    /^\s*$/,          // empty
    /^page\s*\d+/i,   // page numbers
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 2) continue;
    if (skipPatterns.some((p) => p.test(trimmed))) continue;

    // ── Category detection ──────────────────────────────────────────────────
    const cat = detectCategory(trimmed);
    if (cat) {
      currentCategory = cat;
      // Reset columns when category changes
      // (don't reset immediately — column header usually comes right after)
    }

    // ── Column header detection ─────────────────────────────────────────────
    const cols = detectColumnHeaders(trimmed);
    if (cols) {
      currentColumns = cols;
      continue; // Don't treat header line as a price row
    }

    // ── Price row detection ─────────────────────────────────────────────────
    const tokens = trimmed.split(/\s+/);
    const numbers = tokens.filter((t) => /^\d{2,6}(\.\d+)?$/.test(t));

    if (numbers.length < 1) continue;

    const firstNumIndex = tokens.findIndex((t) => /^\d{2,6}(\.\d+)?$/.test(t));
    if (firstNumIndex <= 0) continue;

    const itemName = tokens.slice(0, firstNumIndex).join(" ").trim();
    const values = tokens.slice(firstNumIndex).filter((t) => /^\d[\d,\.]*$/.test(t));

    if (!itemName || /^\d+$/.test(itemName) || itemName.length < 2) continue;

    // Apply keyword filter
    if (keyword && !itemName.toUpperCase().includes(keyword)) continue;

    // Map values to column headers if we have them
    const prices = {};
    if (currentColumns.length > 0) {
      currentColumns.forEach((col, idx) => {
        if (values[idx] !== undefined) {
          prices[col] = values[idx];
        }
      });
    } else {
      // No headers detected — use generic size_1, size_2 keys
      values.forEach((v, idx) => {
        prices[`col_${idx + 1}`] = v;
      });
    }

    rows.push({
      category: currentCategory,
      itemName,
      prices,       // { "25": "74", "32": "150", "40": "337", ... }
      values,       // raw array ["74", "150", "337", ...]
      rawLine: trimmed,
    });
  }

  return rows;
}

/**
 * Group parsed rows by category for a clean structured response.
 * @param {Array} rows - Output of parsePriceRows()
 * @returns {Object} - { SERENE: { columns, items: [...] }, SWR: { columns, items: [...] }, ... }
 */
function groupByCategory(rows) {
  const grouped = {};

  for (const row of rows) {
    const cat = row.category || "GENERAL";
    if (!grouped[cat]) {
      grouped[cat] = {
        category: cat,
        columns: [],
        items: [],
      };
    }

    // Collect all unique column keys seen in this category
    const cols = Object.keys(row.prices);
    for (const col of cols) {
      if (!grouped[cat].columns.includes(col)) {
        grouped[cat].columns.push(col);
      }
    }

    grouped[cat].items.push({
      itemName: row.itemName,
      prices: row.prices,
      rawLine: row.rawLine,
    });
  }

  return grouped;
}

module.exports = { extractPriceListFromPDF, parsePriceRows, groupByCategory };