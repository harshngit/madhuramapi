/**
 * po_pdf.js
 * Utility to generate a Purchase Order PDF from PO data (fetched from DB).
 * Uses pdfkit (pure Node.js, no browser needed).
 *
 * Install dependency:
 *   npm install pdfkit
 *
 * Place this file at: src/utils/po_pdf.js
 */

const PDFDocument = require("pdfkit");

/**
 * Generates a PO PDF buffer from a PO record (row from `pos` table).
 * @param {Object} po  - A single row from the `pos` table
 * @returns {Promise<Buffer>} - Resolves with a PDF buffer
 */
function generatePOPdf(po) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 30, bottom: 30, left: 40, right: 40 },
      });

      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const pageWidth = doc.page.width;   // 595.28
      const leftMargin = 40;
      const rightMargin = 40;
      const contentWidth = pageWidth - leftMargin - rightMargin; // 515.28

      // ─── Colours ───────────────────────────────────────────────────────────
      const PRIMARY = "#1a1a2e";
      const ACCENT  = "#4a90d9";
      const LIGHT_BG = "#f5f7fa";
      const BORDER   = "#cccccc";
      const WHITE    = "#ffffff";

      // ─── HEADER ────────────────────────────────────────────────────────────
      // Top coloured band
      doc.rect(0, 0, pageWidth, 90).fill(PRIMARY);

      // "ME" logo circle
      doc.circle(72, 45, 28).fill(ACCENT);
      doc.fontSize(18).fillColor(WHITE).font("Helvetica-Bold")
        .text("ME", 58, 34);

      // Company name + address block
      doc.fontSize(16).fillColor(WHITE).font("Helvetica-Bold")
        .text(po.company_name || "MADHURAM ENTERPRISES", 115, 12, { width: 380, align: "center" });

      doc.fontSize(8).fillColor("#ccddff").font("Helvetica")
        .text(po.company_subtitle || "PLUMBING & FIRE FIGHTING CONTRACTORS", 115, 32, { width: 380, align: "center" });

      const address = "401, B.T SUJATA SOCIETY, RAM NAGAR, NEAR SAIBABA MANDIR SIGNAL, BORIVALI (WEST), MUMBAI - 400092, MAHARASHTRA";
      doc.fontSize(7).fillColor("#aabbee")
        .text(address, 115, 44, { width: 380, align: "center" });

      if (po.company_email) {
        doc.fontSize(7).fillColor("#aabbee")
          .text(`Email: ${po.company_email}`, 115, 56, { width: 380, align: "center" });
      }
      if (po.company_gst) {
        doc.fontSize(8).fillColor(WHITE).font("Helvetica-Bold")
          .text(`GST NO: ${po.company_gst}`, 115, 68, { width: 380, align: "center" });
      }

      // ─── PURCHASE ORDER TITLE ──────────────────────────────────────────────
      doc.rect(leftMargin, 100, contentWidth, 22).fill(LIGHT_BG).stroke(BORDER);
      doc.fontSize(13).fillColor(PRIMARY).font("Helvetica-Bold")
        .text("PURCHASE ORDER", leftMargin, 105, { width: contentWidth, align: "center" });

      // ─── PO META (Indent No, Order No, Dates) ─────────────────────────────
      let y = 132;
      const col1 = leftMargin;
      const col2 = leftMargin + contentWidth / 2 + 10;

      const formatDate = (d) => {
        if (!d) return "";
        const dt = new Date(d);
        if (isNaN(dt)) return d;
        return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" });
      };

      // Row 1
      doc.fontSize(8).fillColor("#666666").font("Helvetica")
        .text("Indent No.", col1, y)
        .text("Order No :", col2, y);
      doc.fontSize(9).fillColor(PRIMARY).font("Helvetica-Bold")
        .text(po.indent_no || "-", col1 + 60, y)
        .text(po.order_no || "-", col2 + 60, y);
      doc.moveTo(col1, y + 14).lineTo(col1 + contentWidth / 2 - 5, y + 14).stroke(BORDER);
      doc.moveTo(col2, y + 14).lineTo(col2 + contentWidth / 2 - 5, y + 14).stroke(BORDER);

      y += 18;
      // Indent Date / PO Date
      doc.fontSize(8).fillColor("#666666").font("Helvetica")
        .text("Dated :", col1, y)
        .text("P.O. Date :", col2, y);
      doc.fontSize(9).fillColor(ACCENT).font("Helvetica-Bold")
        .text(formatDate(po.indent_date) || "-", col1 + 60, y)
        .text(formatDate(po.po_date) || "-", col2 + 70, y);

      y += 20;
      // Vendor & Contact
      doc.fontSize(8).fillColor("#666666").font("Helvetica")
        .text("To :", col1, y)
        .text("Contact Person :", col2, y);
      doc.fontSize(9).fillColor(PRIMARY).font("Helvetica-Bold")
        .text(po.vendor_name || "-", col1 + 30, y)
        .text(po.contact_person || "", col2 + 90, y);
      y += 14;

      // Site & contacts
      doc.fontSize(8).fillColor("#666666").font("Helvetica")
        .text("Site :", col1, y);
      doc.fontSize(9).fillColor(PRIMARY).font("Helvetica-Bold")
        .text(po.site || "-", col1 + 30, y);
      y += 14;
      if (po.site_address) {
        doc.fontSize(8).fillColor("#666666").font("Helvetica")
          .text("Site Address :", col1, y);
        doc.fontSize(8).fillColor("#333333").font("Helvetica")
          .text(po.site_address, col1 + 80, y, { width: contentWidth / 2 - 85 });
      }

      if (po.primary_contact_name || po.primary_contact_number) {
        doc.fontSize(8).fillColor("#555555").font("Helvetica")
          .text(`${po.primary_contact_name || ""} - ${po.primary_contact_number || ""}`, col2 + 10, y);
        y += 12;
      }
      if (po.secondary_contact_name || po.secondary_contact_number) {
        doc.fontSize(8).fillColor("#555555").font("Helvetica")
          .text(`${po.secondary_contact_name || ""} - ${po.secondary_contact_number || ""}`, col2 + 10, y);
        y += 12;
      }

      y += 4;
      // Vendor Address
      if (po.vendor_address) {
        doc.fontSize(8).fillColor("#666666").font("Helvetica")
          .text("Address :", col1, y);
        doc.fontSize(8).fillColor("#333333").font("Helvetica")
          .text(po.vendor_address, col1 + 55, y, { width: contentWidth / 2 - 60 });
        y += 20;
      }

      // ─── ITEMS TABLE ────────────────────────────────────────────────────────
      y += 6;
      const tableTop = y;

      // Column widths (total = contentWidth)
      const cols = {
        sr:   { x: leftMargin,       w: 28 },
        hsn:  { x: leftMargin + 28,  w: 52 },
        desc: { x: leftMargin + 80,  w: 180 },
        qty:  { x: leftMargin + 260, w: 38 },
        uom:  { x: leftMargin + 298, w: 38 },
        rate: { x: leftMargin + 336, w: 55 },
        amt:  { x: leftMargin + 391, w: 65 },
        rem:  { x: leftMargin + 456, w: 59 },
      };

      // Header row
      doc.rect(leftMargin, tableTop, contentWidth, 18).fill(PRIMARY);
      const headerFields = [
        { key: "sr",   label: "Sr. No." },
        { key: "hsn",  label: "HSN Code" },
        { key: "desc", label: "Item Description" },
        { key: "qty",  label: "Qty" },
        { key: "uom",  label: "UOM" },
        { key: "rate", label: "Rate" },
        { key: "amt",  label: "Amount" },
        { key: "rem",  label: "Remarks" },
      ];
      doc.fontSize(7.5).fillColor(WHITE).font("Helvetica-Bold");
      headerFields.forEach(({ key, label }) => {
        doc.text(label, cols[key].x + 3, tableTop + 5, { width: cols[key].w - 4, align: "center" });
      });

      // Items rows
      let items = po.items || [];
      if (typeof items === "string") {
        try { items = JSON.parse(items); } catch { items = []; }
      }

      let rowY = tableTop + 18;
      let rowIndex = 0;

      // Group header rows (where srno is a letter like "A")
      items.forEach((item) => {
        const isGroup = isNaN(parseInt(item.srno)) || item.srno === null;
        const bg = rowIndex % 2 === 0 ? WHITE : LIGHT_BG;

        // Estimate row height
        const descHeight = doc.heightOfString(item.description || "", { width: cols.desc.w - 6, fontSize: 8 });
        const rowH = Math.max(16, descHeight + 6);

        if (isGroup) {
          // Section header
          doc.rect(leftMargin, rowY, contentWidth, rowH).fill("#e8edf5");
          doc.fontSize(8).fillColor(PRIMARY).font("Helvetica-Bold")
            .text(`${item.srno || ""}  ${item.description || ""}`, leftMargin + 5, rowY + 4, { width: contentWidth - 10 });
        } else {
          doc.rect(leftMargin, rowY, contentWidth, rowH).fill(bg);
          doc.fontSize(8).fillColor("#333333").font("Helvetica");

          doc.text(String(item.srno ?? ""), cols.sr.x + 2,   rowY + 4, { width: cols.sr.w - 4,   align: "center" });
          doc.text(String(item.hsn  ?? ""), cols.hsn.x + 2,  rowY + 4, { width: cols.hsn.w - 4,  align: "center" });
          doc.text(item.description || "",  cols.desc.x + 3, rowY + 4, { width: cols.desc.w - 6 });
          doc.text(String(item.qty  ?? ""), cols.qty.x + 2,  rowY + 4, { width: cols.qty.w - 4,  align: "center" });
          doc.text(String(item.UOM  ?? ""), cols.uom.x + 2,  rowY + 4, { width: cols.uom.w - 4,  align: "center" });
          doc.text(fmtNum(item.Rate),       cols.rate.x + 2, rowY + 4, { width: cols.rate.w - 4, align: "right" });
          doc.text(fmtNum(item.Amount),     cols.amt.x + 2,  rowY + 4, { width: cols.amt.w - 4,  align: "right" });
          doc.text(item.remark || "",       cols.rem.x + 2,  rowY + 4, { width: cols.rem.w - 4 });
        }

        // Bottom border per row
        doc.moveTo(leftMargin, rowY + rowH).lineTo(leftMargin + contentWidth, rowY + rowH).strokeColor(BORDER).lineWidth(0.3).stroke();

        rowY += rowH;
        rowIndex++;
      });

      // Vertical lines for table
      Object.values(cols).forEach(({ x }) => {
        doc.moveTo(x, tableTop).lineTo(x, rowY).strokeColor(BORDER).lineWidth(0.3).stroke();
      });
      doc.moveTo(leftMargin + contentWidth, tableTop).lineTo(leftMargin + contentWidth, rowY).strokeColor(BORDER).lineWidth(0.3).stroke();

      // ─── NOTES & TAX SUMMARY ───────────────────────────────────────────────
      rowY += 6;
      const notesWidth = contentWidth * 0.55;
      const taxWidth   = contentWidth - notesWidth - 4;
      const taxX       = leftMargin + notesWidth + 4;

      // Notes box
      if (po.notes) {
        doc.rect(leftMargin, rowY, notesWidth, 60).fill(LIGHT_BG).stroke(BORDER);
        doc.fontSize(8).fillColor(PRIMARY).font("Helvetica-Bold").text("Note:", leftMargin + 5, rowY + 5);
        doc.fontSize(7.5).fillColor("#444444").font("Helvetica")
          .text(po.notes, leftMargin + 5, rowY + 16, { width: notesWidth - 10 });
      }

      // Tax summary box
      const taxRows = [];
      if (po.cgst && po.cgst_amount) taxRows.push({ label: `CGST - ${po.cgst}%`, value: fmtNum(po.cgst_amount) });
      if (po.sgst && po.sgst_amount) taxRows.push({ label: `SGST - ${po.sgst}%`, value: fmtNum(po.sgst_amount) });
      if (po.discount_amount)        taxRows.push({ label: "Discount",            value: `- ${fmtNum(po.discount_amount)}` });

      let taxRowY = rowY;
      doc.rect(taxX, taxRowY, taxWidth, 60).fill(LIGHT_BG).stroke(BORDER);

      taxRows.forEach((r, i) => {
        const ty = taxRowY + 6 + i * 14;
        doc.fontSize(8).fillColor("#333333").font("Helvetica")
          .text(r.label, taxX + 6, ty, { width: taxWidth / 2 - 8 })
          .text(r.value, taxX + taxWidth / 2, ty, { width: taxWidth / 2 - 6, align: "right" });
      });

      // Total Amount
      rowY += 66;
      doc.rect(taxX, rowY - 2, taxWidth, 20).fill(PRIMARY);
      doc.fontSize(9).fillColor(WHITE).font("Helvetica-Bold")
        .text("Total Amount", taxX + 6, rowY + 3, { width: taxWidth / 2 - 8 })
        .text(fmtNum(po.total_amount), taxX + taxWidth / 2, rowY + 3, { width: taxWidth / 2 - 6, align: "right" });

      // ─── DISCOUNT / TAX / DELIVERY / PAYMENT FOOTER ROW ───────────────────
      rowY += 26;
      const halfW = contentWidth / 2;

      doc.rect(leftMargin,           rowY, halfW, 16).fill(LIGHT_BG).stroke(BORDER);
      doc.rect(leftMargin + halfW,   rowY, halfW, 16).fill(LIGHT_BG).stroke(BORDER);
      doc.fontSize(8).fillColor("#555555").font("Helvetica")
        .text("Discount:", leftMargin + 5, rowY + 4)
        .text(po.discount ? `${po.discount}%` : "Nil", leftMargin + 60, rowY + 4, { width: halfW - 70, align: "center" })
        .text("Tax:", leftMargin + halfW + 5, rowY + 4)
        .text(po.cgst ? `GST - ${(parseFloat(po.cgst) + parseFloat(po.sgst || 0)).toFixed(0)}%` : "-",
          leftMargin + halfW + 50, rowY + 4, { width: halfW - 60, align: "center" });

      rowY += 16;
      doc.rect(leftMargin,           rowY, halfW, 16).fill(LIGHT_BG).stroke(BORDER);
      doc.rect(leftMargin + halfW,   rowY, halfW, 16).fill(LIGHT_BG).stroke(BORDER);
      doc.fontSize(8).fillColor("#555555").font("Helvetica")
        .text("Delivery:", leftMargin + 5, rowY + 4)
        .text(po.delivery || "-", leftMargin + 55, rowY + 4, { width: halfW - 65, align: "center" })
        .text("Payment:", leftMargin + halfW + 5, rowY + 4)
        .text(po.payment || "-", leftMargin + halfW + 55, rowY + 4, { width: halfW - 65, align: "center" });

      // ─── TERMS & CONDITIONS ────────────────────────────────────────────────
      rowY += 22;
      doc.fontSize(8).fillColor(PRIMARY).font("Helvetica-Bold").text("Terms & Conditions:", leftMargin, rowY);
      rowY += 12;
      const terms = [
        "Please send your order acceptance on receipt of this order.",
        "Send all the material in single trip along with delivery challan & test certificate.",
        "Your payment term will begin from the date of material delivered at site.",
        "Transportation as per discussion (Subject to all material arrived at site as per PO)",
      ];
      doc.fontSize(7.5).fillColor("#555555").font("Helvetica");
      terms.forEach((t, i) => {
        doc.text(`${i + 1}) ${t}`, leftMargin + 5, rowY, { width: contentWidth - 10 });
        rowY += 11;
      });

      // ─── AUTHORISED SIGNATORY ──────────────────────────────────────────────
      rowY += 10;
      doc.moveTo(pageWidth - rightMargin - 120, rowY).lineTo(pageWidth - rightMargin, rowY).strokeColor(BORDER).lineWidth(0.5).stroke();
      doc.fontSize(8).fillColor("#555555").font("Helvetica")
        .text("Authorised Signatory", pageWidth - rightMargin - 120, rowY + 4, { width: 120, align: "center" });

      // ─── FOOTER BAND ───────────────────────────────────────────────────────
      const footerY = doc.page.height - 22;
      doc.rect(0, footerY, pageWidth, 22).fill(PRIMARY);
      doc.fontSize(7).fillColor("#aabbee").font("Helvetica")
        .text(
          `${po.company_name || "MADHURAM ENTERPRISES"} | ${po.company_email || ""}  |  GST: ${po.company_gst || ""}`,
          0, footerY + 7,
          { width: pageWidth, align: "center" }
        );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/** Format number to Indian-style with 2 decimal places */
function fmtNum(val) {
  if (val === null || val === undefined || val === "") return "";
  const n = parseFloat(val);
  if (isNaN(n)) return String(val);
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { generatePOPdf };