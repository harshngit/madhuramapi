const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const unzipper = require("unzipper");

const router = express.Router();

// ─── Multer: .docx only ───────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "../../uploads/mir_parse_temp");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + Math.round(Math.random() * 1e9) + path.extname(file.originalname));
  },
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === ".docx") {
    cb(null, true);
  } else {
    cb(
      new Error(
        `Only .docx files are accepted. You uploaded a "${ext || "unknown"}" file. PDF and other formats are not supported.`
      ),
      false
    );
  }
};

const upload = multer({ storage, fileFilter });

// ─── XML Utilities ────────────────────────────────────────────────────────────

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x2013;/g, "-")
    .replace(/&#x2014;/g, "-")
    .replace(/&#xA0;/g, " ");
}

/** Extract plain text from a single XML element block */
function extractTextFromXml(xmlBlock) {
  const withBreaks = xmlBlock.replace(/<w:br[^/]*(\/)?>/g, "\n");
  const texts = withBreaks.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
  return decodeXmlEntities(texts.map((t) => t.replace(/<[^>]+>/g, "")).join("")).trim();
}

/** Parse all paragraphs from document.xml → array of plain text strings */
function parseParagraphsFromXml(xml) {
  const paraBlocks = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
  return paraBlocks
    .map((p) => extractTextFromXml(p))
    .filter(Boolean);
}

/** Parse all tables → array of tables → rows → cell text strings */
function parseTablesFromXml(xml) {
  const tableBlocks = xml.match(/<w:tbl[\s\S]*?<\/w:tbl>/g) || [];
  return tableBlocks.map((tbl) => {
    const rowBlocks = tbl.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) || [];
    return rowBlocks.map((row) => {
      const cellBlocks = row.match(/<w:tc[ >][\s\S]*?<\/w:tc>/g) || [];
      return cellBlocks.map((cell) => extractTextFromXml(cell));
    });
  });
}

/** Remove duplicate values that come from merged/spanned cells */
function dedupeRow(cells) {
  const seen = new Set();
  const result = [];
  for (const c of cells) {
    const v = c.trim();
    if (!seen.has(v)) { seen.add(v); result.push(v); }
  }
  return result.filter(Boolean);
}

// ─── Extraction Helpers ───────────────────────────────────────────────────────

/** Search table rows for a label → return value in the next cell */
function extractField(rows, labelPatterns) {
  for (const row of rows) {
    const uniq = dedupeRow(row);
    for (let i = 0; i < uniq.length - 1; i++) {
      for (const pat of labelPatterns) {
        if (pat.test(uniq[i]) && uniq[i + 1] && uniq[i + 1] !== uniq[i]) {
          return uniq[i + 1].replace(/\n/g, " ").trim();
        }
      }
    }
  }
  return null;
}

/** Find the first cell in a table that matches the pattern, return its full text */
function extractBlockCell(rows, labelPattern) {
  for (const row of rows) {
    for (const cell of row) {
      if (labelPattern.test(cell)) return cell.trim();
    }
  }
  return null;
}

/** Regex match helper — returns group[1] trimmed or null */
function match(text, pattern) {
  const m = text.match(pattern);
  return m ? m[1].trim() : null;
}

/**
 * Search paragraphs array for one matching labelPattern,
 * then return the next N paragraph(s) after it as the value.
 */
function extractFromParas(paras, labelPattern, nextCount = 1) {
  for (let i = 0; i < paras.length - 1; i++) {
    if (labelPattern.test(paras[i])) {
      const values = [];
      for (let j = 1; j <= nextCount && paras[i + j]; j++) {
        values.push(paras[i + j].trim());
      }
      return values.filter(Boolean).join(" ");
    }
  }
  return null;
}

// ─── Main Parser ──────────────────────────────────────────────────────────────

async function parseMirDocx(filePath) {
  // Open .docx as ZIP → read word/document.xml
  const zip = await unzipper.Open.file(filePath);
  const docEntry = zip.files.find((f) => f.path === "word/document.xml");
  if (!docEntry) throw new Error("Invalid .docx — word/document.xml not found.");

  const xml = (await docEntry.buffer()).toString("utf8");

  const tables = parseTablesFromXml(xml);
  const paras  = parseParagraphsFromXml(xml);

  if (!tables.length) throw new Error("No tables found in the document.");

  // ── TABLE 0: Part A Header ────────────────────────────────────────────────
  const t0 = tables[0];

  const project_name            = extractField(t0, [/^project\s*name$/i]);
  const project_code            = extractField(t0, [/^project\s*code$/i]);
  const client_name             = extractField(t0, [/client\s*\/?\s*employer/i]);
  const pmc                     = extractField(t0, [/pmc\s*\/?.*engineer/i, /^pmc$/i]);
  const contractor              = extractField(t0, [/^contractor$/i]);
  const vendor_code             = extractField(t0, [/^vendor\s*code$/i]);
  const mir_reference_no        = extractField(t0, [/mir\s*ref/i]);
  const material_code           = extractField(t0, [/^material\s*code$/i]);
  const mir_submitted_to        = extractField(t0, [/mir\s*submitted\s*to/i]);
  const reference_docs_attached = extractField(t0, [/ref\.?\s*doc/i]);

  // Dates are blank in template (hand-filled) — try but expect null
  const request_submission_date = extractField(t0, [/request\s*submission/i]) || null;
  const inspection_date_time    = extractField(t0, [/inspection\s*\(date/i]) || null;

  // Discipline row (e.g. Structural / Civil, Plumbing, Facade, etc.)
  const disciplineKeywords = ["structural", "civil", "arch", "landscape", "mechanical", "electrical", "plumbing", "facade"];
  let discipline = null;
  for (const row of t0) {
    const uniq = dedupeRow(row);
    const hits = uniq.filter((v) => disciplineKeywords.some((k) => v.toLowerCase().includes(k)));
    if (hits.length >= 2) { discipline = uniq.join(", "); break; }
  }

  // ── PART A: Material Submittal (from paragraphs — cleaner than cell blob) ──
  // Para 39: "Material Submittal approved (Yes/NO). if Yes,Approval Reference No: UT-MAS-..."
  // Para 42: "Description of Supplied Materials:"
  // Para 43: "1 ) PUMP 2xLCR-..."
  let material_submittal_approved       = null;
  let approval_reference_no             = null;
  let description_of_supplied_materials = null;

  for (let i = 0; i < paras.length; i++) {
    if (/material\s*submittal\s*approved/i.test(paras[i])) {
      material_submittal_approved = /yes/i.test(paras[i]) ? "Yes" : "No";
      approval_reference_no = match(paras[i], /Approval Reference No:\s*([\w\-\/]+)/i);
      break;
    }
  }
  for (let i = 0; i < paras.length - 1; i++) {
    if (/^description\s*of\s*supplied\s*materials/i.test(paras[i])) {
      description_of_supplied_materials = paras[i + 1]
        ? paras[i + 1].replace(/\s+/g, " ").trim()
        : null;
      break;
    }
  }

  // ── PART A: BOQ block (from paragraphs — much cleaner split) ──────────────
  // Para 51: "BOQ Reference : 1.03.1 Manufacturer - Country of Origin: INDIA"
  // Para 52: "Supplier : MADHURAM ENTERPRISES Supplied Quantity and Delivery Note Number: 534 Date..."
  let boq_reference                 = null;
  let manufacturer_country_of_origin = null;
  let supplier                      = null;
  let supplied_quantity             = null;
  let delivery_note_number          = null;
  let date_of_receipt_on_site       = null;
  let storage_location              = null;

  for (let i = 0; i < paras.length; i++) {
    if (/^BOQ\s*Reference/i.test(paras[i])) {
      // Para 51
      boq_reference = match(paras[i], /BOQ Reference\s*[:\s]+([\d.]+)/i);
      manufacturer_country_of_origin = match(paras[i], /Country of Origin:\s*([A-Z]+)(?:\s|$)/i);

      // Para 52 — has supplier, quantity, delivery note, date, storage location
      if (paras[i + 1]) {
        const p52 = paras[i + 1];
        supplier         = match(p52, /Supplier\s*:\s*(.+?)(?=\s{3,}Supplied|\s*Supplied Quantity)/i);
        supplied_quantity = match(p52, /Supplied Quantity[^:]*Number:\s*(\d+)/i);
        delivery_note_number = match(p52, /Delivery Note Number:\s*(\d+)/i);
        date_of_receipt_on_site = match(p52, /Date[^:]*:\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i);
        storage_location = match(p52, /Storage Location:\s*([^\t]+?)(?=\s{3,}Any|\s*Any|$)/i);
      }
      break;
    }
  }

  // ── PART A: Quantities (Previous / Current / Cumulative) ──────────────────
  // These are column labels in the doc — values are filled by hand (blank here)
  let previous_quantity   = null;
  let current_quantity    = null;
  let cumulative_quantity = null;

  for (let i = 0; i < paras.length - 1; i++) {
    if (/^previous\s*quantity/i.test(paras[i]) || /^previous\s*qty/i.test(paras[i])) {
      // Next paragraphs are "Current Qty:", "Cumulative Qty:" — all labels, no values
      // Try to find numeric values after them
      for (let j = i + 1; j < Math.min(i + 6, paras.length); j++) {
        if (/^previous/i.test(paras[j - 1]) && !/qty|quantity|current|cumulative/i.test(paras[j]))
          previous_quantity = paras[j];
        if (/^current/i.test(paras[j - 1]) && !/qty|quantity|previous|cumulative/i.test(paras[j]))
          current_quantity = paras[j];
        if (/^cumulative/i.test(paras[j - 1]) && !/qty|quantity|previous|current/i.test(paras[j]))
          cumulative_quantity = paras[j];
      }
      break;
    }
  }

  // ── PART B: Inspection Checklist ─────────────────────────────────────────
  // From paragraphs 94–101 (cleaner than the merged cell blob)
  const checklistLabels = [
    "physical_damage",
    "delivery_note_correct",
    "conform_material_submittal",
    "test_certificate_with_mtc",
    "field_test_complying",
    "third_party_test_contractor_scope",
    "third_party_test_lodha_scope",
  ];

  const inspection_checklist = {
    physical_damage:                    null,
    delivery_note_details_correct:      null,
    conform_with_approved_submittal:    null,
    test_certificate_with_mtc:          null,
    field_test_results_complying:       null,
    third_party_test_contractor_scope:  null,
    third_party_test_lodha_scope:       null,
  };

  // Scan paragraphs for Part B section
  let inPartB = false;
  for (let i = 0; i < paras.length; i++) {
    if (/^part\s*b:/i.test(paras[i]) || /^inspection\s*reports/i.test(paras[i])) {
      inPartB = true;
    }
    if (!inPartB) continue;

    const p = paras[i];

    if (/physical\s*damage/i.test(p)) {
      inspection_checklist.physical_damage = extractYesNo(p);
    }
    if (/delivery\s*note\s*correct/i.test(p) || /details\s*given\s*in\s*delivery\s*note/i.test(p)) {
      inspection_checklist.delivery_note_details_correct = extractYesNo(p);
    }
    if (/conform\s*with\s*approved\s*material\s*submittal/i.test(p)) {
      inspection_checklist.conform_with_approved_submittal = extractYesNo(p);
    }
    if (/test\s*certificate\s*shall\s*be\s*delivered/i.test(p)) {
      inspection_checklist.test_certificate_with_mtc = extractYesNo(p);
    }
    if (/field\s*test\s*is\s*conducted/i.test(p) || /field\s*test.*complying/i.test(p)) {
      inspection_checklist.field_test_results_complying = extractYesNo(p);
    }
    if (/third\s*party\s*test.*contractor\s*scope/i.test(p)) {
      inspection_checklist.third_party_test_contractor_scope = extractYesNo(p);
    }
    if (/third\s*party\s*test.*lodha/i.test(p)) {
      inspection_checklist.third_party_test_lodha_scope = extractYesNo(p);
    }
  }

  // ── PART B: Comments ─────────────────────────────────────────────────────
  let comments = null;
  for (let i = 0; i < paras.length - 1; i++) {
    if (/^comments:?\s*$/i.test(paras[i])) {
      // Next non-empty paragraph after "Comments:" is the comment text
      for (let j = i + 1; j < Math.min(i + 5, paras.length); j++) {
        const v = paras[j].trim();
        if (!v) continue;
        if (/^lodha|^the above|^code\s*[1-4]/i.test(v)) break;
        comments = v;
        break;
      }
      break;
    }
  }

  // ── PART B: Lodha/PMC Approval Code ──────────────────────────────────────
  // From paragraphs 110–116
  let approval_code = null;
  for (const p of paras) {
    if (/code\s*1\s*[-–]\s*approved/i.test(p))   { approval_code = "Code 1 - Approved - Material can be used"; break; }
    if (/code\s*2\s*[-–]/i.test(p))              { approval_code = "Code 2 - Conditionally Approved"; break; }
    if (/code\s*3\s*[-–]/i.test(p))              { approval_code = "Code 3 - Revise & Resubmit - Material may not be used"; break; }
    if (/code\s*4\s*[-–]/i.test(p))              { approval_code = "Code 4 - For Information and Records Only"; break; }
  }

  // ── CM / PMO Team ─────────────────────────────────────────────────────────
  let cm_team_name  = null;
  let cm_team_signature = null;
  let pmo_team_name = null;
  let pmo_team_signature = null;

  if (tables[1]) {
    const t1 = tables[1];
    for (const row of t1) {
      const uniq = dedupeRow(row);
      if (uniq.some((v) => /^cm\s*team$/i.test(v))) {
        const nameRow = t1[t1.indexOf(row) + 1];
        if (nameRow) {
          const nUniq = dedupeRow(nameRow);
          if (nUniq[0]) {
            const cmParts = nUniq[0].match(/Name:\s*(.+?)\s+Signature:\s*(.*)/i);
            if (cmParts) { cm_team_name = cmParts[1].trim() || null; cm_team_signature = cmParts[2].trim() || null; }
          }
          if (nUniq[1]) {
            const pmoParts = nUniq[1].match(/Name:\s*(.+?)\s+Signature:\s*(.*)/i);
            if (pmoParts) { pmo_team_name = pmoParts[1].trim() || null; pmo_team_signature = pmoParts[2].trim() || null; }
          }
        }
      }
    }
  }

  // ── Build clean response ─────────────────────────────────────────────────
  return {
    // ── Header
    project_name,
    project_code,
    client_name,
    pmc,
    contractor,
    vendor_code,
    mir_reference_no,
    material_code,
    discipline,
    mir_submitted_to,
    reference_docs_attached,
    request_submission_date,
    inspection_date_time,

    // ── Part A
    part_a: {
      material_submittal_approved,
      approval_reference_no,
      description_of_supplied_materials,
      boq_reference,
      manufacturer_country_of_origin,
      supplier,
      supplied_quantity,
      delivery_note_number,
      date_of_receipt_on_site,
      storage_location,
      previous_quantity,
      current_quantity,
      cumulative_quantity,
    },

    // ── Part B
    part_b: {
      inspection_checklist,
      cm_team: { name: cm_team_name, signature: cm_team_signature },
      pmo_team: { name: pmo_team_name, signature: pmo_team_signature },
      comments,
      approval_code,
    },
  };
}

// ─── Helper: extract Yes/No answer from a checklist paragraph ────────────────
function extractYesNo(text) {
  // Look for ticked/selected Yes or No — in this template checkboxes are blank
  // so we just return null (not answered)
  // If the document is filled, the text might say "☑ Yes" or have a specific marker
  if (/\byes\b/i.test(text) && !/\bno\b/i.test(text)) return "Yes";
  if (/\bno\b/i.test(text) && !/\byes\b/i.test(text)) return "No";
  return "Not answered"; // checkbox not ticked (blank template)
}

// ─── POST /api/mir-parser/parse-docx ─────────────────────────────────────────
/**
 * @swagger
 * /api/mir-parser/parse-docx:
 *   post:
 *     summary: Upload and parse a MIR Word document (.docx only — PDF not accepted)
 *     tags: [MIR Parser]
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
 *         description: Clean structured MIR data
 *       400:
 *         description: No file or wrong file type
 *       500:
 *         description: Parse error
 */
router.post("/parse-docx", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: "No file uploaded. Please send a .docx file in the 'file' field. PDF is not accepted.",
    });
  }

  const filePath = req.file.path;

  try {
    const data = await parseMirDocx(filePath);
    return res.json({ success: true, filename: req.file.originalname, data });
  } catch (err) {
    console.error("MIR parse error:", err.message);
    return res.status(500).json({ success: false, error: "Failed to parse document: " + err.message });
  } finally {
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
});

// ─── Multer error handler ─────────────────────────────────────────────────────
router.use((err, req, res, next) => {
  if (err) return res.status(400).json({ success: false, error: err.message });
  next();
});

module.exports = router;