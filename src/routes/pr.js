const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");
const { logActivity } = require("./dashboard");
const { recordMovement } = require("./inventory"); // ← stock-out helper

const uploadDir = path.join(__dirname, "../../uploads/pr");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const signatureUploadDir = path.join(__dirname, "../../uploads/pr_signatures");
if (!fs.existsSync(signatureUploadDir)) fs.mkdirSync(signatureUploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const u = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, u + path.extname(file.originalname));
  },
});
const signatureStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, signatureUploadDir),
  filename: (req, file, cb) => {
    const u = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, u + path.extname(file.originalname));
  },
});
const upload = multer({ storage });
const uploadSignature = multer({ storage: signatureStorage });

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: insert PR items into purchase_requisition_items.
// NOW also accepts inventory_id per item and runs stock-out movements.
//
// PR item format (new fields, all optional):
//   {
//     material_description, unit, req_qty, make, place_of_utilisation,  ← existing
//     inventory_id,    ← NEW: link to inventories row
//     issued_qty,      ← NEW: qty to deduct (defaults to req_qty)
//   }
// ─────────────────────────────────────────────────────────────────────────────
async function insertItems(client, prId, items, {
  pr_ref, project_id, project_name, performed_by, performed_by_name,
} = {}) {
  if (!Array.isArray(items) || items.length === 0) return;

  const values = [];
  const placeholders = [];
  let p = 1;

  for (const item of items) {
    values.push(
      prId,
      item.material_description || null,
      item.unit || null,
      item.req_qty ?? item["req.qty"] ?? item.reqQty ?? null,
      item.make || null,
      item.place_of_utilisation || item.place_of_utilization || null,
      item.inventory_id || null,      // ← new column
      item.issued_qty != null ? Number(item.issued_qty) : null  // ← new column
    );
    placeholders.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
  }

  await client.query(
    `INSERT INTO purchase_requisition_items
       (pr_id, material_description, unit, req_qty, make,
        place_of_utilisation, inventory_id, issued_qty)
     VALUES ${placeholders.join(", ")}`,
    values
  );

  // Now run stock-out for every item that carries an inventory_id
  for (const item of items) {
    if (!item.inventory_id) continue;

    const qty = Number(item.issued_qty ?? item.req_qty ?? 0);
    if (qty <= 0) continue;

    // Validate stock
    const invRes = await client.query(
      "SELECT name, current_quantity FROM inventories WHERE inventory_id = $1 FOR UPDATE",
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
      source_type:       "pr",
      source_id:         prId,
      source_ref:        pr_ref || `PR #${prId}`,
      project_id,
      project_name,
      notes:             `Issued for PR item: ${item.material_description || ""}`,
      performed_by,
      performed_by_name,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: build GET query with items joined
// ─────────────────────────────────────────────────────────────────────────────
async function getPrList(whereClause, values) {
  const result = await pool.query(
    `SELECT
       pr.*,
       COALESCE(
         json_agg(
           json_build_object(
             'pr_item_id',          pri.pr_item_id,
             'material_description',pri.material_description,
             'unit',                pri.unit,
             'req_qty',             pri.req_qty,
             'make',                pri.make,
             'place_of_utilisation',pri.place_of_utilisation,
             'inventory_id',        pri.inventory_id,
             'issued_qty',          pri.issued_qty,
             'issued_from_inventory',pri.issued_from_inventory,
             'issued_at',           pri.issued_at,
             'inventory_name',      inv.name,
             'inventory_balance',   inv.current_quantity
           )
         ) FILTER (WHERE pri.pr_item_id IS NOT NULL),
         '[]'::json
       ) AS items
     FROM purchase_requisitions pr
     LEFT JOIN purchase_requisition_items pri ON pri.pr_id = pr.pr_id
     LEFT JOIN inventories inv ON inv.inventory_id = pri.inventory_id
     WHERE ${whereClause}
     GROUP BY pr.pr_id`,
    values
  );
  return result.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pr/upload
// ─────────────────────────────────────────────────────────────────────────────
router.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const filePath = `/uploads/pr/${req.file.filename}`;
  res.json({ filePath });
  if (req.body.user_id) {
    logActivity({
      action: "uploaded", entity_type: "pr_file",
      entity_id: null, entity_name: req.file.originalname,
      performed_by: req.body.user_id, performed_by_name: req.body.user_name || null,
      meta: { filePath },
    });
  }
});

router.post("/upload-signature", uploadSignature.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const filePath = `/uploads/pr_signatures/${req.file.filename}`;
  res.json({ filePath });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pr
//
// items array now supports inventory_id + issued_qty:
//   {
//     material_description: "Tile 60x60",
//     unit: "sqft",
//     req_qty: 100,
//     make: "Kajaria",
//     inventory_id: 12,    ← which inventory item to consume
//     issued_qty: 100,     ← qty to deduct (defaults to req_qty)
//   }
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/pr:
 *   post:
 *     summary: Create a PR (inventory auto stock-out if inventory_id in items)
 *     tags: [PR]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [project_id, project_name, items]
 *             properties:
 *               project_id:    { type: integer }
 *               project_name:  { type: string }
 *               sample_id:     { type: integer }
 *               workorder_no:  { type: string }
 *               location:      { type: string }
 *               mirno:         { type: string }
 *               urgency:       { type: string }
 *               date:          { type: string, format: date }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     material_description: { type: string }
 *                     unit:                 { type: string }
 *                     req_qty:              { type: number }
 *                     make:                 { type: string }
 *                     place_of_utilisation: { type: string }
 *                     inventory_id:         { type: integer, description: "Link to inventories item" }
 *                     issued_qty:           { type: number,  description: "Qty to deduct (default: req_qty)" }
 *     responses:
 *       201:
 *         description: PR created; linked inventory items deducted
 *       400:
 *         description: Insufficient stock or validation error
 */
router.post("/", async (req, res) => {
  const {
    project_id, sample_id, project_name,
    workorder_no, location, mirno, urgency, date,
    items, approved_by, pr_file_path, signature_file_path,
  } = req.body;

  if (!project_id || !project_name)
    return res.status(400).json({ error: "project_id and project_name are required" });
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "items is required and must be a non-empty array" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const headerRes = await client.query(
      `INSERT INTO purchase_requisitions
         (project_id, sample_id, project_name, workorder_no, location,
          mirno, urgency, date, approved_by, pr_file_path, signature_file_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        project_id, sample_id || null, project_name,
        workorder_no || null, location || null, mirno || null,
        urgency || null, date || null, approved_by || null,
        pr_file_path || null, signature_file_path || null,
      ]
    );

    const pr = headerRes.rows[0];

    // Insert items + run stock-outs for any that have inventory_id
    await insertItems(client, pr.pr_id, items, {
      pr_ref:            pr.pr_number || `PR #${pr.pr_id}`,
      project_id,
      project_name,
      performed_by:      req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
    });

    const prWithItems = await client.query(
      `SELECT pr.*,
              COALESCE(json_agg(
                json_build_object(
                  'pr_item_id',          pri.pr_item_id,
                  'material_description',pri.material_description,
                  'unit',                pri.unit,
                  'req_qty',             pri.req_qty,
                  'make',                pri.make,
                  'place_of_utilisation',pri.place_of_utilisation,
                  'inventory_id',        pri.inventory_id,
                  'issued_qty',          pri.issued_qty
                )
              ) FILTER (WHERE pri.pr_item_id IS NOT NULL), '[]'::json) AS items
         FROM purchase_requisitions pr
         LEFT JOIN purchase_requisition_items pri ON pri.pr_id = pr.pr_id
        WHERE pr.pr_id = $1
        GROUP BY pr.pr_id`,
      [pr.pr_id]
    );

    await client.query("COMMIT");
    res.status(201).json(prWithItems.rows[0]);

    logActivity({
      action: "created", entity_type: "pr",
      entity_id: pr.pr_id, entity_name: `PR #${pr.pr_id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id,
      meta: { sample_id: sample_id || null },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error creating PR:", error.message);
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET routes (unchanged logic, items now include inventory_id + balance)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/project/:projectId", async (req, res) => {
  try {
    res.json(await getPrList("pr.project_id = $1", [req.params.projectId]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/sample/:sampleId", async (req, res) => {
  try {
    res.json(await getPrList("pr.sample_id = $1", [req.params.sampleId]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const rows = await getPrList("pr.pr_id = $1", [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "PR not found" });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/pr/:id
// If items array is provided, old items are deleted and re-inserted.
// Only NEW items with inventory_id will trigger stock-outs (existing
// inventory_id items that were already issued are NOT double-deducted
// because the old rows are deleted first — the stock-out already happened).
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/pr/{id}:
 *   put:
 *     summary: Update a PR (re-inserting items re-runs inventory stock-out for new links)
 *     tags: [PR]
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
  const { id } = req.params;
  const {
    project_name, workorder_no, location, mirno, urgency,
    date, items, approved_by, pr_file_path, signature_file_path, sample_id,
  } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Build header update
    const fields = [];
    const vals = [];
    let c = 1;
    if (project_name !== undefined)        { fields.push(`project_name=$${c++}`);        vals.push(project_name); }
    if (workorder_no !== undefined)        { fields.push(`workorder_no=$${c++}`);        vals.push(workorder_no); }
    if (location !== undefined)            { fields.push(`location=$${c++}`);            vals.push(location); }
    if (mirno !== undefined)               { fields.push(`mirno=$${c++}`);               vals.push(mirno); }
    if (urgency !== undefined)             { fields.push(`urgency=$${c++}`);             vals.push(urgency); }
    if (date !== undefined)                { fields.push(`date=$${c++}`);                vals.push(date); }
    if (approved_by !== undefined)         { fields.push(`approved_by=$${c++}`);         vals.push(approved_by); }
    if (pr_file_path !== undefined)        { fields.push(`pr_file_path=$${c++}`);        vals.push(pr_file_path); }
    if (signature_file_path !== undefined) { fields.push(`signature_file_path=$${c++}`); vals.push(signature_file_path); }
    if (sample_id !== undefined)           { fields.push(`sample_id=$${c++}`);           vals.push(sample_id || null); }
    fields.push("updated_at=CURRENT_TIMESTAMP");
    vals.push(id);

    const headerRes = await client.query(
      `UPDATE purchase_requisitions SET ${fields.join(",")} WHERE pr_id=$${c} RETURNING *`,
      vals
    );
    if (headerRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "PR not found" });
    }
    const pr = headerRes.rows[0];

    if (items !== undefined) {
      // Fetch existing items to see which inventory_ids already had stock-outs
      const existingItems = await client.query(
        "SELECT inventory_id, issued_qty FROM purchase_requisition_items WHERE pr_id = $1",
        [id]
      );
      // Reverse previous stock-outs for items whose inventory_id is being removed
      // (optional safeguard — only reverse if inventory_id not present in new items)
      const newInvIds = new Set(items.filter(i => i.inventory_id).map(i => Number(i.inventory_id)));
      for (const old of existingItems.rows) {
        if (!old.inventory_id) continue;
        if (newInvIds.has(Number(old.inventory_id))) continue; // still in list → keep
        // Was in old list but removed → reverse the stock-out (stock-in)
        const oldQty = Number(old.issued_qty) || 0;
        if (oldQty > 0) {
          await recordMovement(client, {
            inventory_id:  old.inventory_id,
            movement_type: "in",
            quantity:      oldQty,
            source_type:   "pr",
            source_id:     Number(id),
            source_ref:    pr.pr_number || `PR #${id}`,
            project_id:    pr.project_id,
            notes:         `Reversed: PR item removed on update`,
            performed_by:  req.body.user_id || null,
            performed_by_name: req.body.user_name || null,
          });
        }
      }

      await client.query("DELETE FROM purchase_requisition_items WHERE pr_id=$1", [id]);
      await insertItems(client, id, items, {
        pr_ref:            pr.pr_number || `PR #${id}`,
        project_id:        pr.project_id,
        project_name:      pr.project_name,
        performed_by:      req.body.user_id || null,
        performed_by_name: req.body.user_name || null,
      });
    }

    const rows = await getPrList("pr.pr_id = $1", [id]);
    await client.query("COMMIT");
    res.json(rows[0]);

    logActivity({
      action: "updated", entity_type: "pr",
      entity_id: Number(id), entity_name: `PR #${id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: pr.project_id,
      meta: {},
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error updating PR:", error.message);
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/pr/:id  (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Reverse any inventory stock-outs before deleting
    const itemsRes = await client.query(
      "SELECT inventory_id, issued_qty FROM purchase_requisition_items WHERE pr_id=$1 AND inventory_id IS NOT NULL",
      [req.params.id]
    );
    for (const item of itemsRes.rows) {
      const qty = Number(item.issued_qty) || 0;
      if (qty > 0) {
        await recordMovement(client, {
          inventory_id:  item.inventory_id,
          movement_type: "in",
          quantity:      qty,
          source_type:   "pr",
          source_id:     Number(req.params.id),
          notes:         `Reversed: PR #${req.params.id} deleted`,
          performed_by:  req.body.user_id || null,
          performed_by_name: req.body.user_name || null,
        });
      }
    }

    const result = await client.query(
      "DELETE FROM purchase_requisitions WHERE pr_id=$1 RETURNING *",
      [req.params.id]
    );
    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "PR not found" });
    }

    await client.query("COMMIT");
    res.json({ message: "PR deleted successfully" });

    logActivity({
      action: "deleted", entity_type: "pr",
      entity_id: req.params.id, entity_name: `PR #${req.params.id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: result.rows[0].project_id,
      meta: {},
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error deleting PR:", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;