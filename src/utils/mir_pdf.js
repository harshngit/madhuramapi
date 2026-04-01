/**
 * mir_pdf.js
 * Utility to generate a Material Inspection Report (MIR) PDF from MIR data.
 */

const PDFDocument = require("pdfkit");
const path = require("path");
const fs = require("fs");

/**
 * Generates a MIR PDF buffer from a MIR record.
 * @param {Object} mir  - A single row from the `mirs` table
 * @returns {Promise<Buffer>} - Resolves with a PDF buffer
 */
function generateMIRPdf(mir) {
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

      const pageWidth = doc.page.width;
      const leftMargin = 40;
      const rightMargin = 40;
      const contentWidth = pageWidth - leftMargin - rightMargin;

      const PRIMARY = "#1a1a2e";
      const ACCENT  = "#4a90d9";
      const LIGHT_BG = "#f5f7fa";
      const BORDER   = "#cccccc";
      const WHITE    = "#ffffff";

      // ─── HEADER ────────────────────────────────────────────────────────────
      doc.rect(0, 0, pageWidth, 90).fill(PRIMARY);
      doc.circle(72, 45, 28).fill(ACCENT);
      doc.fontSize(18).fillColor(WHITE).font("Helvetica-Bold").text("ME", 58, 34);

      doc.fontSize(16).fillColor(WHITE).font("Helvetica-Bold")
        .text("MADHURAM ENTERPRISES", 115, 12, { width: 380, align: "center" });

      doc.fontSize(8).fillColor("#ccddff").font("Helvetica")
        .text("PLUMBING & FIRE FIGHTING CONTRACTORS", 115, 32, { width: 380, align: "center" });

      const address = "401, B.T SUJATA SOCIETY, RAM NAGAR, NEAR SAIBABA MANDIR SIGNAL, BORIVALI (WEST), MUMBAI - 400092, MAHARASHTRA";
      doc.fontSize(7).fillColor("#aabbee").text(address, 115, 44, { width: 380, align: "center" });

      // ─── TITLE ─────────────────────────────────────────────────────────────
      doc.rect(leftMargin, 100, contentWidth, 22).fill(LIGHT_BG).stroke(BORDER);
      doc.fontSize(13).fillColor(PRIMARY).font("Helvetica-Bold")
        .text("MATERIAL INSPECTION REPORT (MIR)", leftMargin, 105, { width: contentWidth, align: "center" });

      // ─── MIR META ───────────────────────────────────────────────────────────
      let y = 132;
      const col1 = leftMargin;
      const col2 = leftMargin + contentWidth / 2 + 10;

      const formatDate = (d) => {
        if (!d) return "-";
        const dt = new Date(d);
        return isNaN(dt) ? d : dt.toLocaleDateString("en-IN");
      };

      doc.fontSize(8).fillColor("#666666").font("Helvetica")
        .text("MIR Ref No:", col1, y)
        .text("Project Name:", col2, y);
      doc.fontSize(9).fillColor(PRIMARY).font("Helvetica-Bold")
        .text(mir.mir_refrence_no || `MIR #${mir.mir_id}`, col1 + 55, y)
        .text(mir.project_name || "-", col2 + 60, y);

      y += 18;
      doc.fontSize(8).fillColor("#666666").font("Helvetica")
        .text("Inspection Date:", col1, y)
        .text("Challan No:", col2, y);
      doc.fontSize(9).fillColor(ACCENT).font("Helvetica-Bold")
        .text(formatDate(mir.inspection_date_time), col1 + 70, y)
        .text(mir.challan_no || "-", col2 + 55, y);

      y += 18;
      doc.fontSize(8).fillColor("#666666").font("Helvetica")
        .text("Client Name:", col1, y)
        .text("Contractor:", col2, y);
      doc.fontSize(9).fillColor(PRIMARY).font("Helvetica-Bold")
        .text(mir.client_name || "-", col1 + 55, y)
        .text(mir.contractor || "-", col2 + 55, y);

      // ─── ITEMS TABLE ────────────────────────────────────────────────────────
      y += 25;
      const tableTop = y;
      const cols = {
        sr:   { x: leftMargin,       w: 30 },
        desc: { x: leftMargin + 30,  w: 240 },
        qty:  { x: leftMargin + 270, w: 60 },
        uom:  { x: leftMargin + 330, w: 50 },
        rate: { x: leftMargin + 380, w: 65 },
        amt:  { x: leftMargin + 445, w: 70 },
      };

      doc.rect(leftMargin, tableTop, contentWidth, 18).fill(PRIMARY);
      doc.fontSize(8).fillColor(WHITE).font("Helvetica-Bold");
      doc.text("Sr.",   cols.sr.x + 2,   tableTop + 5, { width: cols.sr.w - 4,   align: "center" });
      doc.text("Material Description", cols.desc.x + 5, tableTop + 5);
      doc.text("Qty",   cols.qty.x + 2,  tableTop + 5, { width: cols.qty.w - 4,  align: "center" });
      doc.text("UOM",   cols.uom.x + 2,  tableTop + 5, { width: cols.uom.w - 4,  align: "center" });
      doc.text("Rate",  cols.rate.x + 2, tableTop + 5, { width: cols.rate.w - 4, align: "center" });
      doc.text("Amount", cols.amt.x + 2, tableTop + 5, { width: cols.amt.w - 4, align: "center" });

      let rowY = tableTop + 18;
      (mir.items || []).forEach((item, i) => {
        const descHeight = doc.heightOfString(item.description || "", { width: cols.desc.w - 10, fontSize: 8 });
        const rowH = Math.max(20, descHeight + 10);

        if (rowY + rowH > doc.page.height - 60) {
          doc.addPage();
          rowY = 40;
        }

        doc.rect(leftMargin, rowY, contentWidth, rowH).fill(i % 2 === 0 ? WHITE : LIGHT_BG);
        doc.fontSize(8).fillColor("#333333").font("Helvetica");

        doc.text(String(i + 1), cols.sr.x, rowY + 6, { width: cols.sr.w, align: "center" });
        doc.text(item.description || "-", cols.desc.x + 5, rowY + 6, { width: cols.desc.w - 10 });
        doc.text(String(item.qty || "-"), cols.qty.x, rowY + 6, { width: cols.qty.w, align: "center" });
        doc.text(item.UOM || "-", cols.uom.x, rowY + 6, { width: cols.uom.w, align: "center" });
        doc.text(item.Rate ? item.Rate.toLocaleString("en-IN") : "-", cols.rate.x, rowY + 6, { width: cols.rate.w, align: "right" });
        doc.text(item.Amount ? item.Amount.toLocaleString("en-IN") : "-", cols.amt.x, rowY + 6, { width: cols.amt.w, align: "right" });

        doc.moveTo(leftMargin, rowY + rowH).lineTo(leftMargin + contentWidth, rowY + rowH).strokeColor(BORDER).lineWidth(0.3).stroke();
        rowY += rowH;
      });

      // ─── FOOTER ───────────────────────────────────────────────────────────
      rowY += 20;
      doc.fontSize(8).fillColor(PRIMARY).font("Helvetica-Bold").text("Remarks / Dynamic Fields:", leftMargin, rowY);
      rowY += 12;
      (mir.dynamic_field || []).forEach((df) => {
          doc.fontSize(8).fillColor("#555555").font("Helvetica")
             .text(`${df.label}: ${df.value}`, leftMargin + 10, rowY);
          rowY += 12;
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateMIRPdf };
