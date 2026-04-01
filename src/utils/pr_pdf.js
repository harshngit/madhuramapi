/**
 * pr_pdf.js
 * Utility to generate a Purchase Requisition PDF from PR data.
 */

const PDFDocument = require("pdfkit");
const path = require("path");
const fs = require("fs");

/**
 * Generates a PR PDF buffer from a PR record.
 * @param {Object} pr  - A single row from the `purchase_requisitions` table
 * @returns {Promise<Buffer>} - Resolves with a PDF buffer
 */
function generatePRPdf(pr) {
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
        .text("PURCHASE REQUISITION", leftMargin, 105, { width: contentWidth, align: "center" });

      // ─── PR META ───────────────────────────────────────────────────────────
      let y = 132;
      const col1 = leftMargin;
      const col2 = leftMargin + contentWidth / 2 + 10;

      const formatDate = (d) => {
        if (!d) return "-";
        const dt = new Date(d);
        return isNaN(dt) ? d : dt.toLocaleDateString("en-IN");
      };

      doc.fontSize(8).fillColor("#666666").font("Helvetica")
        .text("PR No:", col1, y)
        .text("Project:", col2, y);
      doc.fontSize(9).fillColor(PRIMARY).font("Helvetica-Bold")
        .text(pr.pr_id ? `PR #${pr.pr_id}` : "-", col1 + 40, y)
        .text(pr.project_name || "-", col2 + 40, y);

      y += 18;
      doc.fontSize(8).fillColor("#666666").font("Helvetica")
        .text("Date:", col1, y)
        .text("Urgency:", col2, y);
      doc.fontSize(9).fillColor(ACCENT).font("Helvetica-Bold")
        .text(formatDate(pr.date), col1 + 40, y)
        .text(pr.urgency || "-", col2 + 50, y);

      y += 18;
      doc.fontSize(8).fillColor("#666666").font("Helvetica")
        .text("Location:", col1, y)
        .text("MIR No:", col2, y);
      doc.fontSize(9).fillColor(PRIMARY).font("Helvetica-Bold")
        .text(pr.location || "-", col1 + 50, y)
        .text(pr.mirno || "-", col2 + 40, y);

      // ─── ITEMS TABLE ────────────────────────────────────────────────────────
      y += 25;
      const tableTop = y;
      const cols = {
        sr:   { x: leftMargin,       w: 30 },
        desc: { x: leftMargin + 30,  w: 220 },
        unit: { x: leftMargin + 250, w: 50 },
        qty:  { x: leftMargin + 300, w: 60 },
        make: { x: leftMargin + 360, w: 80 },
        util: { x: leftMargin + 440, w: 75 },
      };

      doc.rect(leftMargin, tableTop, contentWidth, 18).fill(PRIMARY);
      doc.fontSize(8).fillColor(WHITE).font("Helvetica-Bold");
      doc.text("Sr.",   cols.sr.x + 2,   tableTop + 5, { width: cols.sr.w - 4,   align: "center" });
      doc.text("Description", cols.desc.x + 5, tableTop + 5);
      doc.text("Unit",  cols.unit.x + 2, tableTop + 5, { width: cols.unit.w - 4, align: "center" });
      doc.text("Qty",   cols.qty.x + 2,  tableTop + 5, { width: cols.qty.w - 4,  align: "center" });
      doc.text("Make",  cols.make.x + 2, tableTop + 5, { width: cols.make.w - 4, align: "center" });
      doc.text("Utilisation", cols.util.x + 2, tableTop + 5, { width: cols.util.w - 4, align: "center" });

      let rowY = tableTop + 18;
      (pr.items || []).forEach((item, i) => {
        const descHeight = doc.heightOfString(item.material_description || "", { width: cols.desc.w - 10, fontSize: 8 });
        const rowH = Math.max(20, descHeight + 10);

        if (rowY + rowH > doc.page.height - 60) {
          doc.addPage();
          rowY = 40;
        }

        doc.rect(leftMargin, rowY, contentWidth, rowH).fill(i % 2 === 0 ? WHITE : LIGHT_BG);
        doc.fontSize(8).fillColor("#333333").font("Helvetica");

        doc.text(String(i + 1), cols.sr.x, rowY + 6, { width: cols.sr.w, align: "center" });
        doc.text(item.material_description || "-", cols.desc.x + 5, rowY + 6, { width: cols.desc.w - 10 });
        doc.text(item.unit || "-", cols.unit.x, rowY + 6, { width: cols.unit.w, align: "center" });
        doc.text(String(item.req_qty || "-"), cols.qty.x, rowY + 6, { width: cols.qty.w, align: "center" });
        doc.text(item.make || "-", cols.make.x, rowY + 6, { width: cols.make.w, align: "center" });
        doc.text(item.place_of_utilisation || "-", cols.util.x, rowY + 6, { width: cols.util.w, align: "center" });

        doc.moveTo(leftMargin, rowY + rowH).lineTo(leftMargin + contentWidth, rowY + rowH).strokeColor(BORDER).lineWidth(0.3).stroke();
        rowY += rowH;
      });

      // ─── SIGNATURE ──────────────────────────────────────────────────────────
      rowY += 30;
      if (pr.signature_file_path) {
          const sigPath = path.join(__dirname, "../../", pr.signature_file_path);
          if (fs.existsSync(sigPath)) {
              doc.image(sigPath, leftMargin, rowY, { width: 100 });
              rowY += 60;
          }
      }
      doc.fontSize(8).fillColor(PRIMARY).font("Helvetica-Bold").text("Approved By:", leftMargin, rowY);
      doc.fontSize(9).text(pr.approved_by || "-", leftMargin + 60, rowY);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generatePRPdf };
