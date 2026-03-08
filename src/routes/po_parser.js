/**
 * routes/po_parser.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Upload a scanned / digital PO PDF and get back a fully-structured JSON object
 * that matches every field used in routes/po.js  (POST /api/po).
 *
 * HOW TO REGISTER IN src/index.js
 * ────────────────────────────────
 *   const poParserRoutes = require("./routes/po_parser");
 *   app.use("/api/po-parser", poParserRoutes);
 *
 * ENDPOINTS
 * ─────────────────────────────────────────────────────────────────────────────
 *   POST /api/po-parser/parse
 *     - multipart/form-data, field name: "file"  (PDF)
 *     - Returns parsed PO JSON ready to POST to /api/po
 *
 *   POST /api/po-parser/parse-and-save
 *     - Parses the PDF AND immediately inserts it into the `pos` table
 *     - Body: multipart/form-data  { file: <PDF>, project_id: <number> }
 *     - Returns the newly created DB row
 */

const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const PDFParser = require("pdf2json");
const { logActivity } = require("./dashboard"); // adjust path if needed


// ─── Upload directory (temp – files deleted after parsing) ───────────────────
const uploadDir = path.join(__dirname, "../../uploads/po_parser");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `po-${unique}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are allowed"), false);
  },
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

// ─── Helper: delete temp file silently ───────────────────────────────────────
function cleanup(filePath) {
  if (filePath && fs.existsSync(filePath)) fs.unlink(filePath, () => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Extract positioned text items from PDF via pdf2json
// ─────────────────────────────────────────────────────────────────────────────
function extractTextItems(pdfPath) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser();

    parser.on("pdfParser_dataReady", (data) => {
      const items = [];
      for (const page of data.Pages) {
        for (const t of page.Texts) {
          let txt;
          const raw = t.R.map((r) => r.T).join("");
          try {
            txt = decodeURIComponent(raw).trim();
          } catch (_) {
            txt = raw.trim(); // fallback for chars like % in "CGST - 9%"
          }
          if (txt) {
            items.push({
              x: Math.round(t.x * 10) / 10,
              y: Math.round(t.y * 10) / 10,
              txt,
            });
          }
        }
      }
      // Sort top-to-bottom, left-to-right — critical for find() to work correctly
      items.sort((a, b) => a.y - b.y || a.x - b.x);
      resolve(items);
    });

    parser.on("pdfParser_dataError", reject);
    parser.loadPDF(pdfPath);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — Parse the positioned text items into a structured PO object
// ─────────────────────────────────────────────────────────────────────────────
function parsePO(items) {

  // ── Locate label items ────────────────────────────────────────────────────
  const orderNoItem   = items.find((i) => /order\s*no/i.test(i.txt));
  const toItem        = items.find((i) => /^To\s*:/.test(i.txt));
  const poDateItem    = items.find((i) => /P\.O\.?\s*Date/i.test(i.txt));
  const siteItem      = items.find((i) => /^Site\s*:/i.test(i.txt));
  const addressItem   = items.find((i) => /^Address\s*:/i.test(i.txt));
  const contactItem   = items.find((i) => /Contact\s*Person/i.test(i.txt));
  const datedItem     = items.find((i) => /Dated/i.test(i.txt));
  const companyItem   = items.find((i) => i.txt.length > 5 && i.y < 10 && i.x > 10);
  const gstItem       = items.find((i) => /GST\s*NO/i.test(i.txt));

  // ── Helper: get the first value to the right of a label, filtered by x ───
  const rightOf = (labelItem, xMax = 40) => {
    if (!labelItem) return "";
    return (
      items.find(
        (i) =>
          Math.abs(i.y - labelItem.y) < 0.8 &&
          i.x > labelItem.x + 1 &&
          i.x < xMax &&
          i.txt !== labelItem.txt
      )?.txt || ""
    );
  };

  // Use filter+sort for fields where multiple candidates may exist at the same Y
  const firstRightOf = (labelItem, xMin, xMax = 40) => {
    if (!labelItem) return "";
    const candidates = items.filter(
      (i) =>
        Math.abs(i.y - labelItem.y) < 0.8 &&
        i.x > (xMin !== undefined ? xMin : labelItem.x + 1) &&
        i.x < xMax
    );
    return candidates[0]?.txt?.trim() || "";
  };

  // ── HEADER fields ─────────────────────────────────────────────────────────
  const indent_date = datedItem
    ? datedItem.txt.replace(/Dated\s*[-–:]\s*/i, "").trim()
    : "";

  const order_no = firstRightOf(orderNoItem, orderNoItem?.x + 1, 40);

  // Vendor name is on the LEFT half of the page (x < 22) at To row
  const vendor_name = firstRightOf(toItem, toItem?.x + 1, 22);

  // PO date is on the right half (x > 25)
  const po_date = firstRightOf(poDateItem, 25, 40);

  // Site is on the LEFT half
  const site = firstRightOf(siteItem, siteItem?.x + 1, 22);

  // Address — collect multi-line items in LEFT column below addressItem
  let vendor_address = "";
  if (addressItem) {
    const addrLines = items
      .filter(
        (i) =>
          i.y >= addressItem.y &&
          i.y <= addressItem.y + 2.5 &&
          i.x > 3 &&
          i.x < 22
      )
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((i) => i.txt.trim());
    vendor_address = addrLines.join(", ");
  }

  // Contact persons — right-hand column, near contactItem
  const contact_persons = [];
  if (contactItem) {
    const cpItems = items.filter(
      (i) =>
        i.y >= contactItem.y &&
        i.y <= contactItem.y + 1.5 &&
        i.x > 20 &&
        !/Contact\s*Person/i.test(i.txt)
    );
    cpItems.sort((a, b) => a.y - b.y);
    contact_persons.push(...cpItems.map((i) => i.txt.trim()));
  }

  // Primary / secondary contact (split "Name - Number" patterns)
  let primary_contact_name = "";
  let primary_contact_number = "";
  let secondary_contact_name = "";
  let secondary_contact_number = "";

  contact_persons.forEach((cp, idx) => {
    const match = cp.match(/^(.+?)\s*[-–]\s*([\d]+)$/);
    const name   = match ? match[1].trim() : cp;
    const number = match ? match[2].trim() : "";
    if (idx === 0) { primary_contact_name = name; primary_contact_number = number; }
    if (idx === 1) { secondary_contact_name = name; secondary_contact_number = number; }
  });

  const contact_person = contact_persons.join(", ");

  // Company info
  const company_name     = companyItem?.txt?.trim().replace(/\s+/g, " ") || "";
  const company_gst      = gstItem ? gstItem.txt.replace(/GST\s*NO\s*:?\s*/i, "").trim() : "";

  // ── LINE ITEMS ────────────────────────────────────────────────────────────
  const headerRow = items.find((i) => i.txt === "Sr. No." || i.txt === "Sr.No.");
  const headerY   = headerRow?.y || 16;

  // CGST row marks end of items area
  const cgstItem = items.find((i) => /CGST/i.test(i.txt));
  const cgst_y   = cgstItem?.y || 999;

  // Collect item-area rows
  const rowItems = items.filter(
    (i) => i.y > headerY + 0.3 && i.y < cgst_y - 0.3
  );

  // Group by Y
  const rowGroups = {};
  for (const item of rowItems) {
    const key = item.y.toFixed(1);
    if (!rowGroups[key]) rowGroups[key] = [];
    rowGroups[key].push(item);
  }

  // Column X boundaries (matches typical Madhuram PO layout)
  const COL = {
    srno:   { min: 3.5,  max: 6.0  },
    hsn:    { min: 6.0,  max: 9.0  },
    desc:   { min: 9.0,  max: 21.5 },
    qty:    { min: 21.5, max: 23.5 },
    uom:    { min: 23.5, max: 25.8 },
    rate:   { min: 25.8, max: 28.5 },
    amount: { min: 28.5, max: 32.0 },
    remark: { min: 32.0, max: 40.0 },
  };

  const getCol = (rowArr, col) =>
    rowArr
      .filter((i) => i.x >= COL[col].min && i.x <= COL[col].max)
      .map((i) => i.txt.trim())
      .filter(Boolean)
      .join(" ");

  const lineItems = [];
  let currentGroup = null;
  const sortedYs = Object.keys(rowGroups)
    .map(Number)
    .sort((a, b) => a - b);

  for (const y of sortedYs) {
    const row    = rowGroups[y.toFixed(1)];
    const srno   = getCol(row, "srno");
    const hsn    = getCol(row, "hsn");
    const desc   = getCol(row, "desc");
    const qty    = getCol(row, "qty");
    const uom    = getCol(row, "uom");
    const rate   = getCol(row, "rate");
    const amount = getCol(row, "amount");
    const remark = getCol(row, "remark");

    if (!srno && !hsn && !desc && !qty && !uom && !rate && !amount && !remark) continue;

    // Group-header row (e.g. "A" — category label with no qty/rate)
    if (srno && !hsn && !qty && !rate) {
      currentGroup = srno;
      continue;
    }

    if (srno || desc || hsn) {
      lineItems.push({
        srno:        srno   || "",
        hsn:         hsn    || "",
        description: desc   || "",
        qty:         qty    ? parseFloat(qty.replace(/,/g, ""))    : null,
        UOM:         uom    || "",
        Rate:        rate   ? parseFloat(rate.replace(/,/g, ""))   : null,
        Amount:      amount ? parseFloat(amount.replace(/,/g, "")) : null,
        remark:      remark || "",
      });
    }
  }

  // ── TAX rows ──────────────────────────────────────────────────────────────
  const sgstItem = items.find((i) => /SGST/i.test(i.txt));

  const getTaxRow = (taxLabelItem) => {
    if (!taxLabelItem) return { label: "", rate: null, amount: null };
    const label = taxLabelItem.txt.trim();
    const rateMatch = label.match(/([\d.]+)%/);
    const taxRate   = rateMatch ? parseFloat(rateMatch[1]) : null;

    const allRight = items.filter(
      (i) => Math.abs(i.y - taxLabelItem.y) < 0.5 && i.x > 28
    );
    const valItem  = allRight.find((i) => /\d/.test(i.txt));
    const amount   = valItem ? parseFloat(valItem.txt.replace(/[\s,]/g, "")) : null;

    return {
      label: label.replace(/\s*-\s*[\d.]+%/, "").trim(),
      rate:  taxRate,
      amount,
    };
  };

  const cgstParsed = getTaxRow(cgstItem);
  const sgstParsed = getTaxRow(sgstItem);

  // ── Totals ────────────────────────────────────────────────────────────────
  const totalLabelItem = items.find((i) => /Total\s*Amount/i.test(i.txt));
  const totalValItem   = totalLabelItem
    ? items.find(
        (i) =>
          Math.abs(i.y - totalLabelItem.y) < 0.5 &&
          i.x > totalLabelItem.x &&
          /\d/.test(i.txt)
      )
    : null;
  const total_amount = totalValItem
    ? parseFloat(totalValItem.txt.replace(/[\s,]/g, ""))
    : null;

  // Subtotal (last amount value before CGST row)
  const subtotalItem = items.find(
    (i) =>
      /^[\d,]+\.\d{2}$/.test(i.txt) &&
      i.y > headerY + 1 &&
      i.y < cgst_y - 1 &&
      i.x > 28
  );
  const after_discount = subtotalItem
    ? parseFloat(subtotalItem.txt.replace(/,/g, ""))
    : null;

  // ── Footer fields ─────────────────────────────────────────────────────────
  const discountLabel = items.find((i) => i.txt.trim() === "Discount:");
  const taxFootLabel  = items.find((i) => i.txt.trim() === "Tax:");
  const deliveryLabel = items.find((i) => i.txt.trim() === "Delivery:");
  const paymentLabel  = items.find((i) => i.txt.trim() === "Payment:");

  const footerFooter = ["Discount:", "Tax:", "Delivery:", "Payment:"];

  const getFooterValue = (labelItem) => {
    if (!labelItem) return "";
    return (
      items.find(
        (i) =>
          Math.abs(i.y - labelItem.y) < 0.8 &&
          i.x > labelItem.x + 1 &&
          !footerFooter.includes(i.txt.trim())
      )?.txt?.trim() || ""
    );
  };

  const discount_str = getFooterValue(discountLabel);
  const discount     = discount_str && /\d/.test(discount_str)
    ? parseFloat(discount_str.replace(/[%,]/g, ""))
    : 0;

  const delivery = getFooterValue(deliveryLabel);
  const payment  = getFooterValue(paymentLabel);

  // ── Notes ─────────────────────────────────────────────────────────────────
  const noteLabel = items.find((i) => i.txt.trim() === "Note:");
  const noteLines = [];
  if (noteLabel) {
    const totalY = totalLabelItem?.y || 38;
    const noteItems = items.filter(
      (i) =>
        i.y >= noteLabel.y &&
        i.y < totalY &&
        i.x >= noteLabel.x - 0.5 &&
        i.x < 25 // exclude right-side CGST/SGST labels
    );
    noteItems.sort((a, b) => a.y - b.y || a.x - b.x);
    for (const ni of noteItems) {
      if (ni.txt.trim() === "Note:") continue;
      if (/^\d+\)/.test(ni.txt.trim())) {
        noteLines.push(ni.txt.trim());
      } else if (noteLines.length > 0) {
        noteLines[noteLines.length - 1] += " " + ni.txt.trim();
      }
    }
  }
  const notes = noteLines.join("\n");

  // ── Build result matching pos table schema ────────────────────────────────
  return {
    // Company (from PO header)
    company_name,
    company_subtitle: "",         // not always in PDF — fill manually if needed
    company_email:    "",         // not always in PDF
    company_gst,

    // PO header
    indent_no:   indent_date,    // "Indent No." is the dated field in this PO format
    indent_date,
    order_no,
    po_date,

    // Vendor
    vendor_name,
    site,
    contact_person,
    vendor_address,
    primary_contact_name,
    primary_contact_number,
    secondary_contact_name,
    secondary_contact_number,

    // Line items (array — store as JSON in DB)
    items: lineItems,

    // Tax
    cgst:         cgstParsed.rate,
    cgst_amount:  cgstParsed.amount,
    sgst:         sgstParsed.rate,
    sgst_amount:  sgstParsed.amount,

    // Totals
    discount,
    discount_amount: 0,          // discount amount not separately listed in this PO format
    after_discount,
    total_amount,

    // Footer
    delivery,
    payment,
    notes,

    status: "created",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 1 — POST /api/po-parser/parse
// Upload PO PDF → returns parsed JSON (does NOT save to DB)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/po-parser/parse:
 *   post:
 *     summary: Parse a Purchase Order PDF and return structured JSON
 *     description: |
 *       Upload any Madhuram-format PO PDF.
 *       Returns a fully-structured JSON object matching all fields in POST /api/po.
 *       Does NOT save to the database — use /api/po-parser/parse-and-save for that.
 *     tags: [PO]
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
 *                 description: The PO PDF file
 *     responses:
 *       200:
 *         description: PO parsed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 filename:
 *                   type: string
 *                 data:
 *                   type: object
 *                   description: Parsed PO fields matching the pos table schema
 *       400:
 *         description: No file uploaded
 *       500:
 *         description: Parsing failed
 */
router.post("/parse", upload.single("file"), async (req, res) => {
  if (!req.file)
    return res.status(400).json({ success: false, error: "No PDF file uploaded. Use field name 'file'." });

  try {
    const items  = await extractTextItems(req.file.path);
    const parsed = parsePO(items);
    cleanup(req.file.path);

    return res.json({
      success:  true,
      filename: req.file.originalname,
      data:     parsed,
    });
  } catch (error) {
    cleanup(req.file.path);
    console.error("PO parse error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});



module.exports = router;