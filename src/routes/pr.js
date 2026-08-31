const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");
const { generatePrPdf } = require("../utils/pr_pdf");
const { logActivity, getEntityHistory, attachCreatedUpdatedBy } = require("./dashboard");
const { generateEmailTemplate, formatCurrency, formatDate } = require("../utils/emailHelper");
const { recordMovement } = require("./inventory"); // ← stock-out helper

const uploadDir = path.join(__dirname, "../../uploads/pr");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const signatureUploadDir = path.join(__dirname, "../../uploads/pr_signatures");
if (!fs.existsSync(signatureUploadDir)) fs.mkdirSync(signatureUploadDir, { recursive: true });

/**
 * @swagger
 * tags:
 *   name: PR
 *   description: |
 *     Purchase Requisition management. Every GET (list/by-id/by-project/by-sample)
 *     response also includes created_by/created_by_name/updated_by/updated_by_name
 *     — see the CreatedUpdatedBy schema.
 */

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
//     quantity,        ← NEW: plain quantity value, mirrors samples' item.quantity
//     inventory_id,    ← link to inventories row
//     issued_qty,      ← qty to deduct (defaults to req_qty)
//     boq_id,          ← NEW: link to boqs row (informational only — does not
//                          deduct boqs.used_quantity; that's samples-only)
//     boq_qty,         ← NEW: qty being requisitioned against that BOQ item
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
      item.issued_qty != null ? Number(item.issued_qty) : null,  // ← new column
      item.boq_id || null,            // ← new column
      item.boq_qty != null ? Number(item.boq_qty) : null,  // ← new column
      item.item_no || null,           // ← stored as sent, independent of boq_item_code
      item.quantity != null ? Number(item.quantity) : null  // ← new column
    );
    placeholders.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
  }

  await client.query(
    `INSERT INTO purchase_requisition_items
       (pr_id, material_description, unit, req_qty, make,
        place_of_utilisation, inventory_id, issued_qty, boq_id, boq_qty, item_no, quantity)
     VALUES ${placeholders.join(", ")}`,
    values
  );

  // Now run stock-out for every item that carries an inventory_id.
  // Stock for one material is often split across several inventories rows
  // (each sample/DC/PO stock-in creates its own row rather than accumulating
  // into an existing one), so if the chosen inventory_id alone can't cover
  // the requested qty, pull the shortfall from other rows for the same
  // material (same name + project) before failing.
  for (const item of items) {
    if (!item.inventory_id) continue;

    const qty = Number(item.issued_qty ?? item.req_qty ?? 0);
    if (qty <= 0) continue;

    const primaryRes = await client.query(
      "SELECT inventory_id, name, project_id, current_quantity FROM inventories WHERE inventory_id = $1 FOR UPDATE",
      [item.inventory_id]
    );
    if (primaryRes.rows.length === 0)
      throw new Error(`Inventory item ${item.inventory_id} not found`);
    const primary = primaryRes.rows[0];

    const othersRes = await client.query(
      `SELECT inventory_id, current_quantity FROM inventories
         WHERE inventory_id <> $1
           AND current_quantity > 0
           AND lower(name) = lower($2)
           AND project_id IS NOT DISTINCT FROM $3
         ORDER BY created_at ASC
         FOR UPDATE`,
      [primary.inventory_id, primary.name, primary.project_id]
    );

    let remaining = qty;
    const deductions = [];

    const primaryAvail = Number(primary.current_quantity) || 0;
    const takeFromPrimary = Math.min(primaryAvail, remaining);
    if (takeFromPrimary > 0) {
      deductions.push({ inventory_id: primary.inventory_id, take: takeFromPrimary });
      remaining -= takeFromPrimary;
    }

    for (const row of othersRes.rows) {
      if (remaining <= 0) break;
      const avail = Number(row.current_quantity) || 0;
      const take = Math.min(avail, remaining);
      if (take > 0) {
        deductions.push({ inventory_id: row.inventory_id, take });
        remaining -= take;
      }
    }

    if (remaining > 0) {
      throw new Error(
        `Insufficient stock for "${primary.name}": available ${qty - remaining}, requested ${qty}`
      );
    }

    for (const d of deductions) {
      await recordMovement(client, {
        inventory_id:      d.inventory_id,
        movement_type:     "out",
        quantity:          d.take,
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
             'quantity',            pri.quantity,
             'make',                pri.make,
             'place_of_utilisation',pri.place_of_utilisation,
             'inventory_id',        pri.inventory_id,
             'issued_qty',          pri.issued_qty,
             'issued_from_inventory',pri.issued_from_inventory,
             'issued_at',           pri.issued_at,
             'inventory_name',      inv.name,
             'inventory_balance',   inv.current_quantity,
             'boq_id',              pri.boq_id,
             'boq_qty',             pri.boq_qty,
             'boq_item_code',       b.item_code,
             'item_no',             pri.item_no,
             'boq_remaining_quantity', (COALESCE(b.quantity,0) - COALESCE(b.used_quantity,0))
           )
         ) FILTER (WHERE pri.pr_item_id IS NOT NULL),
         '[]'::json
       ) AS items
     FROM purchase_requisitions pr
     LEFT JOIN purchase_requisition_items pri ON pri.pr_id = pr.pr_id
     LEFT JOIN inventories inv ON inv.inventory_id = pri.inventory_id
     LEFT JOIN boqs b ON b.boq_id = pri.boq_id
     WHERE ${whereClause}
     GROUP BY pr.pr_id`,
    values
  );
  return attachCreatedUpdatedBy(result.rows, "pr", (r) => r.pr_id);
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
// items array now supports inventory_id + issued_qty, and boq_id + boq_qty:
//   {
//     material_description: "Tile 60x60",
//     unit: "sqft",
//     req_qty: 100,
//     quantity: 100,       ← plain quantity value, mirrors sample items' quantity field
//     make: "Kajaria",
//     inventory_id: 12,    ← which inventory item to consume
//     issued_qty: 100,     ← qty to deduct (defaults to req_qty)
//     boq_id: 7,           ← which BOQ item this line was requisitioned against (informational only)
//     boq_qty: 100,        ← qty being requisitioned against that BOQ item
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
 *               sample_id:     { type: string }
 *               pr_number:     { type: string }
 *               workorder_no:  { type: string }
 *               location:      { type: string }
 *               mirno:         { type: string }
 *               urgency:       { type: string }
 *               floor_no:      { type: string }
 *               flat_no:       { type: string }
 *               date:          { type: string, format: date }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     material_description: { type: string }
 *                     unit:                 { type: string }
 *                     req_qty:              { type: number }
 *                     quantity:             { type: number,  description: "Plain quantity value for this line, mirrors sample items' quantity field" }
 *                     make:                 { type: string }
 *                     place_of_utilisation: { type: string }
 *                     inventory_id:         { type: integer, description: "Link to inventories item" }
 *                     issued_qty:           { type: number,  description: "Qty to deduct (default: req_qty)" }
 *                     boq_id:               { type: integer, description: "Link to a BOQ item (boqs.boq_id) — informational only, does not deduct BOQ quantity" }
 *                     boq_qty:              { type: number,  description: "Qty being requisitioned against that BOQ item" }
 *                     item_no:              { type: string,  description: "Item number for this line — stored and returned exactly as sent, independent of boq_item_code (which is looked up live from the linked BOQ item)" }
 *     responses:
 *       201:
 *         description: PR created; linked inventory items deducted
 *       400:
 *         description: Insufficient stock or validation error
 */
router.post("/", async (req, res) => {
  const {
    project_id, sample_id, project_name, pr_number,
    workorder_no, location, mirno, urgency, floor_no, flat_no, date,
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
         (project_id, sample_id, project_name, pr_number, workorder_no, location,
          mirno, urgency, floor_no, flat_no, date, approved_by, pr_file_path, signature_file_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        project_id, sample_id || null, project_name, pr_number || null,
        workorder_no || null, location || null, mirno || null,
        urgency || null, floor_no || null, flat_no || null, date || null, approved_by || null,
        pr_file_path || null, signature_file_path || null,
      ]
    );

    const pr = headerRes.rows[0];

    // Insert items + run stock-outs for any that have inventory_id
    await insertItems(client, pr.pr_id, items, {
      pr_ref:            `PR #${pr.pr_id}`,
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
                  'quantity',            pri.quantity,
                  'make',                pri.make,
                  'place_of_utilisation',pri.place_of_utilisation,
                  'inventory_id',        pri.inventory_id,
                  'issued_qty',          pri.issued_qty,
                  'boq_id',              pri.boq_id,
                  'boq_qty',             pri.boq_qty,
                  'boq_item_code',       b.item_code,
                  'item_no',             pri.item_no,
                  'boq_remaining_quantity', (COALESCE(b.quantity,0) - COALESCE(b.used_quantity,0))
                )
              ) FILTER (WHERE pri.pr_item_id IS NOT NULL), '[]'::json) AS items
         FROM purchase_requisitions pr
         LEFT JOIN purchase_requisition_items pri ON pri.pr_id = pr.pr_id
         LEFT JOIN boqs b ON b.boq_id = pri.boq_id
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
// GET /api/pr/project/:projectId
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/pr/project/{projectId}:
 *   get:
 *     summary: Get all PRs for a specific project
 *     tags: [PR]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: List of PRs for the project
 */
router.get("/project/:projectId", async (req, res) => {
  try {
    res.json(await getPrList("pr.project_id = $1", [req.params.projectId]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pr/sample/:sampleId
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/pr/sample/{sampleId}:
 *   get:
 *     summary: Get all PRs for a specific sample
 *     tags: [PR]
 *     parameters:
 *       - in: path
 *         name: sampleId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of PRs for the sample
 */
router.get("/sample/:sampleId", async (req, res) => {
  try {
    res.json(await getPrList("pr.sample_id = $1", [req.params.sampleId]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pr/:id
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/pr/{id}:
 *   get:
 *     summary: Get a single PR by ID
 *     tags: [PR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: PR details
 *       404:
 *         description: PR not found
 */
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
// GET /api/pr
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/pr:
 *   get:
 *     summary: Get all purchase requisitions
 *     tags: [PR]
 *     responses:
 *       200:
 *         description: List of all PRs
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { type: object }
 */
router.get("/", async (req, res) => {
  try {
    const rows = await getPrList("1=1", []);
    const prs = rows.map(pr => {
      const items = Array.isArray(pr.items) ? pr.items : [];
      const linked = items.length > 0 && items.every(i => i.inventory_id);
      return { ...pr, linked };
    });
    res.json(prs);
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
    project_name, pr_number, workorder_no, location, mirno, urgency, floor_no, flat_no,
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
    if (pr_number !== undefined)           { fields.push(`pr_number=$${c++}`);           vals.push(pr_number); }
    if (workorder_no !== undefined)        { fields.push(`workorder_no=$${c++}`);        vals.push(workorder_no); }
    if (location !== undefined)            { fields.push(`location=$${c++}`);            vals.push(location); }
    if (mirno !== undefined)               { fields.push(`mirno=$${c++}`);               vals.push(mirno); }
    if (urgency !== undefined)             { fields.push(`urgency=$${c++}`);             vals.push(urgency); }
    if (floor_no !== undefined)            { fields.push(`floor_no=$${c++}`);            vals.push(floor_no); }
    if (flat_no !== undefined)             { fields.push(`flat_no=$${c++}`);             vals.push(flat_no); }
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
      // Reverse ALL previous stock-outs recorded for this PR (read from the
      // inventory_movements audit log, not from purchase_requisition_items —
      // a single PR item's issued_qty may have been drawn from multiple
      // inventory rows for the same material, so the movements log is the
      // only accurate record of what was actually deducted and from where).
      // insertItems() below then issues fresh stock-outs for whatever the
      // new item list actually needs.
      const movementsRes = await client.query(
        `SELECT inventory_id, SUM(quantity) AS qty
           FROM inventory_movements
          WHERE source_type = 'pr' AND source_id = $1 AND movement_type = 'out'
          GROUP BY inventory_id`,
        [id]
      );
      for (const row of movementsRes.rows) {
        const oldQty = Number(row.qty) || 0;
        if (oldQty > 0) {
          await recordMovement(client, {
            inventory_id:  row.inventory_id,
            movement_type: "in",
            quantity:      oldQty,
            source_type:   "pr",
            source_id:     Number(id),
            source_ref:    pr.pr_number || `PR #${id}`,
            project_id:    pr.project_id,
            notes:         `Reversed: PR updated (items replaced)`,
            performed_by:  req.body.user_id || null,
            performed_by_name: req.body.user_name || null,
          });
        }
      }

      await client.query("DELETE FROM purchase_requisition_items WHERE pr_id=$1", [id]);
      await insertItems(client, id, items, {
        pr_ref:            `PR #${id}`,
        project_id:        pr.project_id,
        project_name:      pr.project_name,
        performed_by:      req.body.user_id,
        performed_by_name: req.body.user_name,
      });
    }

    const rows = await getPrList("pr.pr_id = $1", [id]);
    await client.query("COMMIT");
    res.json(rows[0]);

    logActivity({
      action: "updated",
      entity_type: "pr",
      entity_id: id,
      entity_name: `PR #${id}`,
      performed_by: req.body.user_id,
      performed_by_name: req.body.user_name,
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

    // Reverse any inventory stock-outs before deleting. Read the actual
    // deductions from inventory_movements (not purchase_requisition_items)
    // since a single PR item's issued_qty may have been split across
    // multiple inventory rows for the same material.
    const movementsRes = await client.query(
      `SELECT inventory_id, SUM(quantity) AS qty
         FROM inventory_movements
        WHERE source_type = 'pr' AND source_id = $1 AND movement_type = 'out'
        GROUP BY inventory_id`,
      [req.params.id]
    );
    for (const row of movementsRes.rows) {
      const qty = Number(row.qty) || 0;
      if (qty > 0) {
        await recordMovement(client, {
          inventory_id:  row.inventory_id,
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pr/:id/history — who created/updated/deleted this PR, and when
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/pr/{id}/history:
 *   get:
 *     summary: Get the create/update/delete history for a PR (who did what, and when)
 *     tags: [PR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *       - in: query
 *         name: offset
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Activity history for this PR
 */
router.get("/:id/history", async (req, res) => {
  try {
    const data = await getEntityHistory("pr", req.params.id, {
      limit: req.query.limit, offset: req.query.offset,
    });
    res.json(data);
  } catch (error) {
    console.error("Error fetching PR history:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: Generate PR PDF
// GET /api/pr/:id/pdf
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/pr/{id}/pdf:
 *   get:
 *     summary: Generate and download a PDF for a PR
 *     tags: [PR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: PDF file stream
 *         content:
 *           application/pdf:
 *             schema: { type: string, format: binary }
 *       404:
 *         description: PR not found
 */
router.get("/:id/pdf", async (req, res) => {
  const { id } = req.params;
  try {
    const rows = await getPrList("pr.pr_id = $1", [id]);
    if (rows.length === 0) return res.status(404).json({ error: "PR not found" });
    const pr = rows[0];

    const pdfBuffer = await generatePRPdf(pr);
    const filename = `PR_${pr.pr_id}_${Date.now()}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error("Error generating PR PDF:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: Upload email attachments for a PR
// POST /api/pr/:id/upload-email-attachment
// ─────────────────────────────────────────────────────────────────────────────
const emailAttachmentDir = path.join(__dirname, "../../uploads/pr_email_attachments");
if (!fs.existsSync(emailAttachmentDir)) fs.mkdirSync(emailAttachmentDir, { recursive: true });

const emailAttachmentStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, emailAttachmentDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});
const uploadEmailAttachment = multer({ storage: emailAttachmentStorage });

/**
 * @swagger
 * /api/pr/{id}/upload-email-attachment:
 *   post:
 *     summary: Upload one or more attachments to be sent with the PR email
 *     tags: [PR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               files:
 *                 type: array
 *                 items: { type: string, format: binary }
 *     responses:
 *       200: { description: Files uploaded successfully }
 */
router.post("/:id/upload-email-attachment", uploadEmailAttachment.array("files", 10), async (req, res) => {
  const { id } = req.params;
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No files uploaded." });
  try {
    const attachments = [];
    for (const file of req.files) {
      const filePath = `/uploads/pr_email_attachments/${file.filename}`;
      await pool.query(
        `INSERT INTO pr_email_attachments
           (pr_id, file_path, original_name, mime_type, size_bytes, uploaded_by_user_id, uploaded_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, filePath, file.originalname, file.mimetype, file.size, req.body.user_id || null, req.body.user_name || null]
      );
      attachments.push({ filePath, originalName: file.originalname });
    }
    return res.status(200).json({ message: `${attachments.length} file(s) uploaded successfully.`, attachments });
  } catch (error) {
    console.error("Error saving email attachment record:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: Send PR Email
// POST /api/pr/:id/send-email
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/pr/{id}/send-email:
 *   post:
 *     summary: Send PR details via email
 *     tags: [PR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [to]
 *             properties:
 *               to: { type: string }
 *               cc: { type: array, items: { type: string } }
 *               message: { type: string }
 *               attachments:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     filePath: { type: string }
 *                     originalName: { type: string }
 *               user_id: { type: string }
 *               user_name: { type: string }
 *     responses:
 *       200: { description: Email sent successfully }
 */
router.post("/:id/send-email", async (req, res) => {
  const { id } = req.params;
  const { to, cc, message, attachments, user_id, user_name } = req.body;
  if (!to) return res.status(400).json({ error: "Recipient email is required." });

  try {
    const rows = await getPrList("pr.pr_id = $1", [id]);
    if (rows.length === 0) return res.status(404).json({ error: "PR not found" });
    const pr = rows[0];

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    // Prepare dynamic content for email template
    const infoItems = [
      { label: "PR ID", value: `PR #${pr.pr_id}` },
      { label: "Date", value: formatDate(pr.date) },
      { label: "Project", value: pr.project_name },
      { label: "Location", value: pr.location },
      { label: "Work Order No", value: pr.workorder_no },
      { label: "Urgency", value: pr.urgency },
      { label: "Approved By", value: pr.approved_by },
      { label: "MIR No", value: pr.mirno }
    ].filter(i => i.value);

    const tableHeaders = ["Description", "UOM", "Req Qty", "Make", "Place of Utilisation"];
    const prItems = Array.isArray(pr.items) ? pr.items : [];

    const htmlBody = generateEmailTemplate({
      title: `Purchase Requisition PR #${pr.pr_id}`,
      message: message || "Please find the details of the Purchase Requisition below and in the attachment.",
      infoItems,
      items: prItems,
      tableHeaders,
      accentColor: "#4c8ac7"
    });

    const nodemailerAttachments = [];
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        const absolutePath = path.join(__dirname, "../../", att.filePath);
        if (fs.existsSync(absolutePath)) {
          nodemailerAttachments.push({ filename: att.originalName, path: absolutePath });
        }
      }
    }

    const mailOptions = {
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      cc: cc?.join(","),
      subject: `Purchase Requisition PR #${pr.pr_id} - ${pr.project_name}`,
      html: htmlBody,
      attachments: nodemailerAttachments,
    };

    let emailStatus = "sent";
    let emailError = null;
    let nodemailerMsgId = null;

    try {
      const info = await transporter.sendMail(mailOptions);
      nodemailerMsgId = info.messageId;
    } catch (sendErr) {
      emailStatus = "failed";
      emailError = sendErr.message;
    }

    const attachmentPaths = nodemailerAttachments.map(a => path.basename(a.path));
    await pool.query(
      `INSERT INTO pr_email_logs (
        pr_id, sent_to, cc_addresses, subject, custom_message,
        attachment_names, status, error_message, nodemailer_msg_id,
        sent_by_user_id, sent_by_name
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, to, cc, mailOptions.subject, message || null, attachmentPaths, emailStatus, emailError, nodemailerMsgId, user_id || null, user_name || null]
    );

    logActivity({
      action: emailStatus === "sent" ? "email_sent" : "email_failed",
      entity_type: "pr",
      entity_id: id,
      entity_name: `PR #${id}`,
      performed_by: user_id || null,
      performed_by_name: user_name || null,
      meta: { to, status: emailStatus },
    });

    return res.json({ message: "Email processed", status: emailStatus });
  } catch (error) {
    console.error("Error sending PR email:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: Get email logs for a PR
// GET /api/pr/:id/email-logs
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/pr/{id}/email-logs:
 *   get:
 *     summary: Get all email send history for a PR
 *     tags: [PR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: List of logs }
 */
router.get("/:id/email-logs", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("SELECT * FROM pr_email_logs WHERE pr_id = $1 ORDER BY sent_at DESC", [id]);
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching PR email logs:", error);
    res.status(500).json({ error: error.message });
  }
});