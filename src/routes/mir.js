const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { logActivity } = require("./dashboard");
const { recordMovement } = require("./inventory"); // ← stock-out helper

const uploadDir = path.join(__dirname, "../../uploads/mir");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const u = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, u + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: scan MIR items array and run stock-out for any item carrying
// an inventory_id that has NOT already been issued (inventory_issued !== true).
//
// MIR item format (new fields added, all optional):
//   {
//     srno, hsn, description, qty, UOM, Rate, Amount, remark,  ← existing
//     inventory_id,    ← NEW: link to inventories table
//     issued_qty,      ← NEW: qty to deduct (defaults to qty)
//     inventory_issued,← set automatically to true after stock-out
//   }
// ─────────────────────────────────────────────────────────────────────────────
async function processMirInventory(client, {
  items,
  previous_items = [],
  mir_id,
  mir_ref,
  project_id,
  project_name,
  performed_by,
  performed_by_name,
}) {
  if (!Array.isArray(items) || items.length === 0) return;

  const alreadyIssued = new Set(
    previous_items
      .filter(i => i.inventory_id && i.inventory_issued)
      .map(i => Number(i.inventory_id))
  );

  for (const item of items) {
    if (!item.inventory_id) continue;
    if (alreadyIssued.has(Number(item.inventory_id))) continue;

    const qty = Number(item.issued_qty ?? item.qty ?? 0);
    if (qty <= 0) continue;

    const invRes = await client.query(
      "SELECT name, current_quantity FROM inventories WHERE inventory_id=$1 FOR UPDATE",
      [item.inventory_id]
    );
    if (invRes.rows.length === 0)
      throw new Error(`Inventory item ${item.inventory_id} not found`);

    const available = Number(invRes.rows[0].current_quantity) || 0;
    if (available < qty)
      throw new Error(
        `Insufficient stock for "${invRes.rows[0].name}": available ${available}, requested ${qty}`
      );

    await recordMovement(client, {
      inventory_id:      item.inventory_id,
      movement_type:     "out",
      quantity:          qty,
      source_type:       "mir",
      source_id:         mir_id,
      source_ref:        mir_ref,
      project_id,
      project_name,
      notes:             `Consumed by MIR: ${mir_ref || `#${mir_id}`}`,
      performed_by,
      performed_by_name,
    });

    // Mark so re-saves don't double-deduct
    item.inventory_issued = true;
    item.inventory_issued_at = new Date().toISOString();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/mir/upload
// ─────────────────────────────────────────────────────────────────────────────
router.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const filePath = `/uploads/mir/${req.file.filename}`;
  res.json({ filePath });
  if (req.body.user_id) {
    logActivity({
      action: "uploaded", entity_type: "mir_file",
      entity_id: null, entity_name: req.file.originalname,
      performed_by: req.body.user_id, performed_by_name: req.body.user_name || null,
      meta: { filePath },
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/mir
//
// items array now supports inventory_id + issued_qty:
//   {
//     srno: 1, hsn: "...", description: "Tile 60x60", qty: 50, UOM: "sqft",
//     inventory_id: 12,   ← which inventory item to consume
//     issued_qty: 50,     ← qty to deduct (defaults to qty)
//   }
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/mir:
 *   post:
 *     summary: Create a MIR (inventory auto stock-out if inventory_id in items)
 *     tags: [MIR]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               project_name:         { type: string }
 *               project_code:         { type: string }
 *               client_name:          { type: string }
 *               pmc:                  { type: string }
 *               contractor:           { type: string }
 *               vendor_code:          { type: string }
 *               challan_no:           { type: string }
 *               mir_refrence_no:      { type: string }
 *               material_code:        { type: string }
 *               inspection_date_time: { type: string, format: date-time }
 *               client_submission_date: { type: string, format: date }
 *               refrence_docs_attached: { type: string }
 *               mir_submited:         { type: boolean }
 *               dynamic_field:        { type: array }
 *               project_id:           { type: integer }
 *               po_id:                { type: integer }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     srno:         { type: integer }
 *                     hsn:          { type: string }
 *                     description:  { type: string }
 *                     qty:          { type: number }
 *                     UOM:          { type: string }
 *                     Rate:         { type: number }
 *                     Amount:       { type: number }
 *                     remark:       { type: string }
 *                     inventory_id: { type: integer, description: "Link to inventories item" }
 *                     issued_qty:   { type: number,  description: "Qty to deduct (default: qty)" }
 *     responses:
 *       201:
 *         description: MIR created; linked inventory items deducted
 *       400:
 *         description: Insufficient stock or bad data
 */
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const {
      project_name, project_code, client_name, pmc, contractor,
      vendor_code, challan_no, mir_refrence_no, material_code,
      inspection_date_time, client_submission_date,
      refrence_docs_attached, mir_submited, dynamic_field,
      project_id, po_id, items,
    } = req.body;

    const mirItems = items || [];

    const result = await client.query(
      `INSERT INTO mirs (
         project_name, project_code, client_name, pmc, contractor, vendor_code,
         challan_no, mir_refrence_no, material_code, inspection_date_time,
         client_submission_date, refrence_docs_attached, mir_submited,
         dynamic_field, project_id, po_id, items
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        project_name, project_code, client_name, pmc, contractor,
        vendor_code, challan_no, mir_refrence_no, material_code,
        inspection_date_time, client_submission_date,
        refrence_docs_attached, mir_submited,
        JSON.stringify(dynamic_field || []),
        project_id, po_id || null,
        JSON.stringify(mirItems),
      ]
    );

    const mir = result.rows[0];

    // Process stock-outs
    await processMirInventory(client, {
      items:             mirItems,
      mir_id:            mir.mir_id,
      mir_ref:           mir_refrence_no || `MIR #${mir.mir_id}`,
      project_id,
      project_name,
      performed_by:      req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
    });

    // If any items got marked inventory_issued, persist the updated array
    if (mirItems.some(i => i.inventory_issued)) {
      await client.query(
        "UPDATE mirs SET items=$1 WHERE mir_id=$2",
        [JSON.stringify(mirItems), mir.mir_id]
      );
      mir.items = mirItems;
    }

    await client.query("COMMIT");
    res.status(201).json(mir);

    logActivity({
      action: "created", entity_type: "mir",
      entity_id: mir.mir_id,
      entity_name: mir_refrence_no || `MIR #${mir.mir_id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: mir.project_id,
      meta: { mir_refrence_no },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error creating MIR:", error.message);
    if (error.code === "23503")
      return res.status(400).json({ error: "Invalid project_id: Project does not exist" });
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/mir  (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    res.json((await pool.query("SELECT * FROM mirs ORDER BY created_at DESC")).rows);
  } catch (e) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/mir/project/:projectId  (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/project/:projectId", async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT * FROM mirs WHERE project_id=$1 ORDER BY created_at DESC",
      [req.params.projectId]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/mir/:id  (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM mirs WHERE mir_id=$1", [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: "MIR not found" });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/mir/:id
// New inventory_id entries in items trigger stock-outs.
// Previously-issued entries (inventory_issued=true) are skipped.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/mir/{id}:
 *   put:
 *     summary: Update a MIR (new inventory_id items auto stock-out)
 *     tags: [MIR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Updated
 *       404:
 *         description: Not found
 */
router.put("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { id } = req.params;
    const {
      project_name, project_code, client_name, pmc, contractor,
      vendor_code, challan_no, mir_refrence_no, material_code,
      inspection_date_time, client_submission_date,
      refrence_docs_attached, mir_submited, dynamic_field, project_id,
      items,
    } = req.body;

    // Fetch existing MIR to get previous items
    const existing = await client.query("SELECT * FROM mirs WHERE mir_id=$1", [id]);
    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "MIR not found" });
    }
    const prevMir = existing.rows[0];
    const prevItems = Array.isArray(prevMir.items) ? prevMir.items : [];

    // Build dynamic UPDATE
    const updateFields = [];
    const values = [];
    let counter = 1;

    if (project_name !== undefined)         { updateFields.push(`project_name=$${counter++}`);         values.push(project_name); }
    if (project_code !== undefined)         { updateFields.push(`project_code=$${counter++}`);         values.push(project_code); }
    if (client_name !== undefined)          { updateFields.push(`client_name=$${counter++}`);          values.push(client_name); }
    if (pmc !== undefined)                  { updateFields.push(`pmc=$${counter++}`);                  values.push(pmc); }
    if (contractor !== undefined)           { updateFields.push(`contractor=$${counter++}`);           values.push(contractor); }
    if (vendor_code !== undefined)          { updateFields.push(`vendor_code=$${counter++}`);          values.push(vendor_code); }
    if (challan_no !== undefined)           { updateFields.push(`challan_no=$${counter++}`);           values.push(challan_no); }
    if (mir_refrence_no !== undefined)      { updateFields.push(`mir_refrence_no=$${counter++}`);      values.push(mir_refrence_no); }
    if (material_code !== undefined)        { updateFields.push(`material_code=$${counter++}`);        values.push(material_code); }
    if (inspection_date_time !== undefined) { updateFields.push(`inspection_date_time=$${counter++}`); values.push(inspection_date_time); }
    if (client_submission_date !== undefined){ updateFields.push(`client_submission_date=$${counter++}`); values.push(client_submission_date); }
    if (refrence_docs_attached !== undefined){ updateFields.push(`refrence_docs_attached=$${counter++}`); values.push(refrence_docs_attached); }
    if (mir_submited !== undefined)         { updateFields.push(`mir_submited=$${counter++}`);         values.push(mir_submited); }
    if (dynamic_field !== undefined)        { updateFields.push(`dynamic_field=$${counter++}`);        values.push(JSON.stringify(dynamic_field)); }
    if (project_id !== undefined)           { updateFields.push(`project_id=$${counter++}`);           values.push(project_id); }

    // Handle items + inventory movements
    const newItems = items !== undefined ? [...items] : null;

    if (newItems) {
      await processMirInventory(client, {
        items:             newItems,
        previous_items:    prevItems,
        mir_id:            Number(id),
        mir_ref:           mir_refrence_no || prevMir.mir_refrence_no || `MIR #${id}`,
        project_id:        project_id || prevMir.project_id,
        project_name:      project_name || prevMir.project_name || null,
        performed_by:      req.body.user_id || null,
        performed_by_name: req.body.user_name || null,
      });
      updateFields.push(`items=$${counter++}`);
      values.push(JSON.stringify(newItems));
    }

    updateFields.push("updated_at=CURRENT_TIMESTAMP");

    if (updateFields.length === 1) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "No fields to update" });
    }

    values.push(id);
    const result = await client.query(
      `UPDATE mirs SET ${updateFields.join(",")} WHERE mir_id=$${counter} RETURNING *`,
      values
    );

    await client.query("COMMIT");
    res.json(result.rows[0]);

    logActivity({
      action: "updated", entity_type: "mir",
      entity_id: id,
      entity_name: result.rows[0].mir_refrence_no || `MIR #${id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: result.rows[0].project_id,
      meta: { updates: req.body },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error updating MIR:", error.message);
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/mir/:id  (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM mirs WHERE mir_id=$1 RETURNING *",
      [req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "MIR not found" });
    res.json({ message: "MIR deleted successfully" });

    logActivity({
      action: "deleted", entity_type: "mir",
      entity_id: req.params.id,
      entity_name: result.rows[0].mir_refrence_no || `MIR #${req.params.id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: result.rows[0].project_id,
      meta: {},
    });
  } catch (error) {
    console.error("Error deleting MIR:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;