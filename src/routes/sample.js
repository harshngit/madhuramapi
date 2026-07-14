const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { logActivity } = require("./dashboard");
const { recordMovement } = require("./inventory"); // stock-out AND stock-in helper
const { getBoqUsageCounts, getBoqUsageDetails } = require("../utils/boqUsage");

const uploadDir = path.join(__dirname, "../../uploads/sample");
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
// HELPER: scan item_description array and stock-out any item that carries
// an inventory_id. Safe to call on both CREATE and UPDATE.
//
// item format (new fields added, all optional — existing items without
// inventory_id are ignored):
//   {
//     sr_no, description, quantity, value, add_fields,  ← existing
//     inventory_id,   ← NEW: links to inventories table
//     issued_qty,     ← NEW: qty to deduct (falls back to `quantity`)
//   }
// ─────────────────────────────────────────────────────────────────────────────
async function processInventoryItems(client, {
  items,
  sample_id,
  sample_ref,
  project_id,
  project_name,
  performed_by,
  performed_by_name,
  // Pass previously stored items so we can detect newly-added inventory links
  previous_items = [],
}) {
  if (!Array.isArray(items) || items.length === 0) return;

  // Build a Set of inventory_ids already issued in previous_items
  const alreadyIssued = new Set(
    previous_items
      .filter(i => i.inventory_id && i.inventory_issued)
      .map(i => Number(i.inventory_id))
  );

  for (const item of items) {
    if (!item.inventory_id) continue;                        // no link → skip
    if (alreadyIssued.has(Number(item.inventory_id))) continue; // already issued → skip

    const qty = Number(item.issued_qty ?? item.quantity ?? 0);
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
      source_type:       "sample",
      source_id:         sample_id,
      source_ref:        sample_ref,
      project_id,
      project_name,
      notes:             `Consumed by Sample: ${sample_ref || `#${sample_id}`}`,
      performed_by,
      performed_by_name,
    });

    // Mark item as issued so re-saves don't double-deduct
    item.inventory_issued = true;
    item.inventory_issued_at = new Date().toISOString();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: scan item_description array and deduct "used_quantity" on any BOQ
// item referenced via boq_id. Mirrors processInventoryItems() above, but
// tracks consumption against boqs.quantity instead of inventories.
//
// item format (new fields added, all optional):
//   {
//     ...existing fields,
//     boq_id,          ← NEW: links to boqs table
//     boq_issued_qty,  ← NEW: qty to consume from that BOQ item (falls back to `quantity`)
//   }
// ─────────────────────────────────────────────────────────────────────────────
async function processBoqItems(client, { items, previous_items = [] }) {
  if (!Array.isArray(items) || items.length === 0) return;

  const alreadyIssued = new Set(
    previous_items
      .filter(i => i.boq_id && i.boq_issued)
      .map(i => Number(i.boq_id))
  );

  for (const item of items) {
    if (!item.boq_id) continue;                          // no link → skip
    if (alreadyIssued.has(Number(item.boq_id))) continue; // already issued → skip

    const qty = Number(item.boq_issued_qty ?? item.quantity ?? 0);
    if (qty <= 0) continue;

    const boqRes = await client.query(
      "SELECT item_code, quantity, used_quantity FROM boqs WHERE boq_id = $1 FOR UPDATE",
      [item.boq_id]
    );
    if (boqRes.rows.length === 0)
      throw new Error(`BOQ item ${item.boq_id} not found`);

    // No hard block on insufficient quantity — BOQ quantities are planning
    // estimates, not a hard cap. used_quantity/remaining_quantity are just
    // calculated and can go negative (over-consumption) without erroring.
    await client.query(
      `UPDATE boqs
          SET used_quantity = COALESCE(used_quantity, 0) + $1,
              updated_at = CURRENT_TIMESTAMP
        WHERE boq_id = $2`,
      [qty, item.boq_id]
    );

    // Mark item as issued so re-saves don't double-deduct
    item.boq_issued = true;
    item.boq_issued_at = new Date().toISOString();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: reverse of processBoqItems() — restore used_quantity on delete
// ─────────────────────────────────────────────────────────────────────────────
async function restoreBoqItems(client, items) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item.boq_id || !item.boq_issued) continue;
    const qty = Number(item.boq_issued_qty ?? item.quantity ?? 0);
    if (qty <= 0) continue;

    await client.query(
      `UPDATE boqs
          SET used_quantity = GREATEST(COALESCE(used_quantity, 0) - $1, 0),
              updated_at = CURRENT_TIMESTAMP
        WHERE boq_id = $2`,
      [qty, item.boq_id]
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: enrich sample(s) item_description with the linked BOQ's item_code
// and remaining_quantity, WITHOUT mutating what's stored in the DB. Used by
// every read (GET) endpoint and by the create/update responses, so the
// frontend (incl. anything that builds a download/export from this data)
// always sees the current item_code for a BOQ-linked item.
//
// Pass { full: true } (used only by GET /api/sample/:id) to also attach the
// FULL cross-entity usage breakdown per item (used_in_pr/po/itr/dc/mir/samples +
// counts) — the same data GET /api/boq/:id returns, but scoped to exactly the
// BOQ item(s) referenced in this one sample. List endpoints keep the cheaper
// total-count-only shape (boq_total_usage_count) to avoid N detail queries
// across a whole list of samples.
// ─────────────────────────────────────────────────────────────────────────────
async function enrichWithBoqInfo(samples, { full = false } = {}) {
  const list = Array.isArray(samples) ? samples : [samples];

  const boqIds = new Set();
  list.forEach(s => {
    const items = Array.isArray(s.item_description) ? s.item_description : [];
    items.forEach(i => {
      const n = Number(i.boq_id);
      if (i.boq_id && Number.isFinite(n)) boqIds.add(n);
    });
  });

  let boqMap = new Map();
  let usageCounts = {};
  let usageDetails = new Map();
  if (boqIds.size > 0) {
    const [boqRes, counts] = await Promise.all([
      pool.query(
        `SELECT boq_id, item_code, description, unit, quantity, used_quantity
           FROM boqs WHERE boq_id = ANY($1)`,
        [[...boqIds]]
      ),
      getBoqUsageCounts([...boqIds]),
    ]);
    boqMap = new Map(boqRes.rows.map(b => [b.boq_id, b]));
    usageCounts = counts;

    if (full) {
      const entries = await Promise.all(
        [...boqIds].map(async id => [id, await getBoqUsageDetails(id)])
      );
      usageDetails = new Map(entries);
    }
  }

  const enriched = list.map(s => {
    const items = Array.isArray(s.item_description) ? s.item_description : [];
    const enrichedItems = items.map(i => {
      if (!i.boq_id) return i;
      const boq = boqMap.get(Number(i.boq_id));
      if (!boq) return i;
      const base = {
        ...i,
        boq_item_code: boq.item_code,
        boq_description: boq.description,
        boq_remaining_quantity: Number(boq.quantity || 0) - Number(boq.used_quantity || 0),
        // Total times this BOQ item has been referenced system-wide (PR + PO + ITR + DC + MIR + samples)
        boq_total_usage_count: usageCounts[Number(i.boq_id)]?.total ?? 0,
      };
      if (full) base.boq_usage = usageDetails.get(Number(i.boq_id));
      return base;
    });
    return { ...s, item_description: enrichedItems };
  });

  return Array.isArray(samples) ? enriched : enriched[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sample/upload
// ─────────────────────────────────────────────────────────────────────────────
router.post("/upload", upload.array("file"), (req, res) => {
  if (!req.files || req.files.length === 0)
    return res.status(400).json({ error: "No files uploaded" });

  const filePaths = req.files.map(f => `/uploads/sample/${f.filename}`);
  res.json({ filePaths });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sample/create-sample
//
// item_description array items can now include:
//   inventory_id  (integer) — which inventory item this line consumes
//   issued_qty    (number)  — how many to deduct (defaults to `quantity`)
//
// Example:
//   items: [
//     { sr_no: 1, description: "Tile 60x60", quantity: 50,
//       inventory_id: 12, issued_qty: 50 }
//   ]
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/sample/create-sample:
 *   post:
 *     summary: Create a sample (inventory auto stock-out if inventory_id in items)
 *     tags: [Sample]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - sample_id
 *               - project_id
 *             properties:
 *               sample_id:        { type: string, example: "SAMPLE-001", description: "Unique sample ID provided by the frontend (can be alphanumeric)" }
 *               project_id:       { type: integer, example: 1 }
 *               flats:            { type: string,  example: "A-101, A-102" }
 *               building_name:    { type: string,  example: "Block A" }
 *               site_name:        { type: string,  example: "Main Site" }
 *               location:
 *                 type: object
 *                 properties:
 *                   floor:        { type: string, example: "2nd" }
 *                   flat_no:      { type: string, example: "A-101" }
 *                   block:        { type: string, example: "B" }
 *                   wing:         { type: string, example: "East" }
 *                   coordinates:  { type: string, example: "19.0760,72.8777" }
 *               work_done:        { type: string, example: "Flooring" }
 *               item_description:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     sr_no:         { type: integer, example: 1 }
 *                     item_name:     { type: string,  example: "Ceramic Tile", description: "Name of the item" }
 *                     item_code:     { type: string,  example: "ITM-007",      description: "Item code / SKU" }
 *                     brand_name:    { type: string,  example: "Kajaria",      description: "Brand of the item" }
 *                     description:   { type: string,  example: "60x60 Glossy White" }
 *                     specification: { type: string,  example: "Grade A, ISO certified" }
 *                     unit:          { type: string,  example: "Nos", description: "Unit of measurement (e.g., Nos, Kg, Mtr)" }
 *                     quantity:      { type: number,  example: 100 }
 *                     value:         { type: number,  example: 45.50 }
 *                     inventory_id:  { type: integer, example: 12,   description: "Link to inventory item for auto stock-out" }
 *                     issued_qty:    { type: number,  example: 100,  description: "Qty to deduct from inventory (defaults to quantity)" }
 *                     boq_id:        { type: integer, example: 7,    description: "Link to a BOQ item (boqs.boq_id) this sample line was taken from" }
 *                     boq_issued_qty: { type: number, example: 100,  description: "Qty to consume from the BOQ item's remaining quantity (defaults to quantity)" }
 *               add_fields:       { type: array }
 *           example:
 *             sample_id: "SAMPLE-001"
 *             project_id: 1
 *             flats: "A-101, A-102"
 *             building_name: "Block A"
 *             site_name: "Main Site"
 *             location:
 *               floor: "2nd"
 *               flat_no: "A-101"
 *               block: "B"
 *               wing: "East"
 *               coordinates: "19.0760,72.8777"
 *             work_done: "Flooring"
 *             item_description:
 *               - sr_no: 1
 *                 item_name: "Ceramic Tile"
 *                 item_code: "ITM-007"
 *                 brand_name: "Kajaria"
 *                 description: "60x60 Glossy White"
 *                 specification: "Grade A, ISO certified"
 *                 unit: "Nos"
 *                 quantity: 100
 *                 value: 45.50
 *                 inventory_id: 12
 *                 issued_qty: 100
 *                 boq_id: 7
 *                 boq_issued_qty: 100
 *               - sr_no: 2
 *                 item_name: "Wall Putty"
 *                 brand_name: "Birla White"
 *                 description: "Interior Wall Putty 40kg"
 *                 specification: "White cement based"
 *                 unit: "Bags"
 *                 quantity: 20
 *                 value: 380.00
 *             add_fields: []
 *     responses:
 *       201:
 *         description: Sample created successfully; linked inventory/BOQ items auto-deducted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:               { type: integer, example: 1, description: "Auto-generated table row ID" }
 *                 sample_id:        { type: string, example: "SAMPLE-001", description: "Frontend-supplied unique sample ID (alphanumeric)" }
 *                 project_id:       { type: integer, example: 1 }
 *                 flats:            { type: string,  example: "A-101, A-102" }
 *                 building_name:    { type: string,  example: "Block A" }
 *                 site_name:        { type: string,  example: "Main Site" }
 *                 location:         { type: object }
 *                 work_done:        { type: string, example: "Flooring" }
 *                 item_description:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       sr_no:              { type: integer }
 *                       item_name:          { type: string }
 *                       item_code:          { type: string }
 *                       brand_name:         { type: string }
 *                       description:        { type: string }
 *                       specification:      { type: string }
 *                       unit:               { type: string }
 *                       quantity:           { type: number }
 *                       value:              { type: number }
 *                       inventory_id:       { type: integer }
 *                       issued_qty:         { type: number }
 *                       inventory_issued:   { type: boolean }
 *                       inventory_issued_at: { type: string, format: date-time }
 *                       boq_id:             { type: integer, description: "BOQ item this line was taken from" }
 *                       boq_issued_qty:     { type: number }
 *                       boq_issued:         { type: boolean }
 *                       boq_issued_at:      { type: string, format: date-time }
 *                       boq_item_code:      { type: string, description: "item_code of the linked BOQ item (looked up live, not stored)" }
 *                       boq_description:    { type: string, description: "description of the linked BOQ item (looked up live, not stored)" }
 *                       boq_remaining_quantity: { type: number, description: "Remaining quantity left on the linked BOQ item after this consumption" }
 *                 add_fields:       { type: array }
 *                 sample_file:      { type: string }
 *                 created_at:       { type: string, format: date-time }
 *                 updated_at:       { type: string, format: date-time }
 *       400:
 *         description: Insufficient inventory stock, invalid project_id, or bad data (BOQ quantity is never blocked — remaining_quantity can go negative)
 *       500:
 *         description: Server error
 */
router.post("/create-sample", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const {
      sample_id: frontend_sample_id,
      project_id, flats, building_name, site_name,
      location, work_done, item_description, add_fields,
    } = req.body;

    if (!frontend_sample_id) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "sample_id is required and must be provided by the client" });
    }

    // Insert sample using the sample_id supplied by the frontend
    const result = await client.query(
      `INSERT INTO samples
         (sample_id, project_id, flats, building_name, site_name, location, work_done, item_description, add_fields)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        frontend_sample_id,
        project_id, flats || null, building_name, site_name,
        location ? JSON.stringify(location) : null,
        work_done,
        item_description ? JSON.stringify(item_description) : JSON.stringify([]),
        add_fields ? JSON.stringify(add_fields) : JSON.stringify([]),
      ]
    );

    const sample = result.rows[0];

    // Process inventory stock-outs for any item with inventory_id
    const items = item_description || [];
    await processInventoryItems(client, {
      items,
      sample_id:         sample.sample_id,
      sample_ref:        building_name || `Sample #${sample.sample_id}`,
      project_id,
      project_name:      req.body.project_name || null,
      performed_by:      req.body.created_by || req.body.user_id || null,
      performed_by_name: req.body.created_by_name || req.body.user_name || null,
    });

    // Process BOQ consumption for any item with boq_id
    await processBoqItems(client, { items });

    // If any items were marked inventory_issued/boq_issued, update the stored JSONB
    if (items.some(i => i.inventory_issued || i.boq_issued)) {
      await client.query(
        "UPDATE samples SET item_description = $1 WHERE sample_id = $2",
        [JSON.stringify(items), sample.sample_id]
      );
      sample.item_description = items;
    }

    await client.query("COMMIT");

    logActivity({
      action: "created", entity_type: "sample",
      entity_id: sample.sample_id,
      entity_name: building_name || `Sample #${sample.sample_id}`,
      performed_by: req.body.created_by || null,
      performed_by_name: req.body.created_by_name || null,
      meta: { project_id },
    });

    res.status(201).json(await enrichWithBoqInfo(sample));
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error creating sample:", error.message);
    if (error.code === "23503")
      return res.status(400).json({ error: "Invalid project_id: Project does not exist" });
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sample
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/sample:
 *   get:
 *     summary: Get all samples
 *     description: |
 *       Each item in `item_description` that carries a `boq_id` is enriched (live, not stored)
 *       with `boq_item_code`, `boq_description`, and `boq_remaining_quantity` from the linked BOQ item.
 *     tags: [Sample]
 *     responses:
 *       200:
 *         description: List of all samples
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   sample_id:     { type: string, example: "SAMPLE-001" }
 *                   project_id:    { type: integer, example: 1 }
 *                   linked:        { type: boolean, description: "true if every item has an inventory_id" }
 *                   item_description:
 *                     type: array
 *                     items:
 *                       type: object
 *                       properties:
 *                         boq_id:                 { type: integer, example: 7 }
 *                         boq_issued_qty:         { type: number, example: 100 }
 *                         boq_issued:             { type: boolean }
 *                         boq_item_code:          { type: string,  example: "ITM-007", description: "Looked up live from the linked BOQ item" }
 *                         boq_description:        { type: string }
 *                         boq_remaining_quantity: { type: number }
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM samples ORDER BY created_at DESC");
    const samples = result.rows.map(s => {
      const items = Array.isArray(s.item_description) ? s.item_description : [];
      const linked = items.length > 0 && items.every(i => i.inventory_id);
      return { ...s, linked };
    });
    res.json(await enrichWithBoqInfo(samples));
  } catch (error) {
    console.error("Error fetching samples:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sample/project/:projectId
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/sample/project/{projectId}:
 *   get:
 *     summary: Get all samples for a specific project
 *     description: |
 *       Each item in `item_description` that carries a `boq_id` is enriched (live, not stored)
 *       with `boq_item_code`, `boq_description`, and `boq_remaining_quantity` from the linked BOQ item.
 *     tags: [Sample]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: List of samples for the project
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   sample_id:  { type: string, example: "SAMPLE-001" }
 *                   project_id: { type: integer, example: 1 }
 *                   item_description:
 *                     type: array
 *                     items:
 *                       type: object
 *                       properties:
 *                         boq_id:                 { type: integer, example: 7 }
 *                         boq_item_code:          { type: string, example: "ITM-007" }
 *                         boq_description:        { type: string }
 *                         boq_remaining_quantity: { type: number }
 *       500:
 *         description: Server error
 */
router.get("/project/:projectId", async (req, res) => {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId)) {
    return res.status(400).json({ error: "projectId must be a valid integer" });
  }

  try {
    const result = await pool.query(
      "SELECT * FROM samples WHERE project_id = $1 ORDER BY created_at DESC",
      [projectId]
    );
    const samples = result.rows.map(s => {
      const items = Array.isArray(s.item_description) ? s.item_description : [];
      const linked = items.length > 0 && items.every(i => i.inventory_id);
      return { ...s, linked };
    });
    res.json(await enrichWithBoqInfo(samples));
  } catch (error) {
    console.error("Error fetching samples by project:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sample/:id
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/sample/{id}:
 *   get:
 *     summary: Get a single sample by ID (includes full BOQ usage breakdown per item)
 *     description: |
 *       Each item in `item_description` that carries a `boq_id` is enriched (live, not stored)
 *       with `boq_item_code`, `boq_description`, and `boq_remaining_quantity` from the linked BOQ item,
 *       plus a full `boq_usage` breakdown — every PR, PO, ITR, DC, and other Sample that has also
 *       referenced that same BOQ item (the same cross-reference `GET /api/boq/:id` returns, scoped
 *       to just the BOQ item(s) used in this sample). This is the one call for "open this sample,
 *       see each BOQ item's total usage everywhere."
 *     tags: [Sample]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Sample details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sample_id:  { type: string, example: "SAMPLE-001" }
 *                 project_id: { type: integer, example: 1 }
 *                 item_description:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       boq_id:                 { type: integer, example: 7 }
 *                       boq_issued_qty:         { type: number, example: 100 }
 *                       boq_issued:             { type: boolean }
 *                       boq_item_code:          { type: string, example: "ITM-007", description: "Looked up live from the linked BOQ item" }
 *                       boq_description:        { type: string }
 *                       boq_remaining_quantity: { type: number }
 *                       boq_total_usage_count:  { type: integer, example: 5, description: "Total references across PR+PO+ITR+DC+MIR+Samples" }
 *                       boq_usage:
 *                         type: object
 *                         description: Full cross-reference for this BOQ item (same shape as GET /api/boq/:id)
 *                         properties:
 *                           used_in_samples: { type: array, items: { type: object } }
 *                           used_in_pr:      { type: array, items: { type: object } }
 *                           used_in_po:      { type: array, items: { type: object } }
 *                           used_in_itr:     { type: array, items: { type: object } }
 *                           used_in_dc:      { type: array, items: { type: object } }
 *                           used_in_mir:     { type: array, items: { type: object } }
 *                           usage_counts:
 *                             type: object
 *                             properties:
 *                               samples: { type: integer }
 *                               pr:      { type: integer }
 *                               po:      { type: integer }
 *                               itr:     { type: integer }
 *                               dc:      { type: integer }
 *                               mir:     { type: integer }
 *                               total:   { type: integer }
 *       404:
 *         description: Sample not found
 */
router.get("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM samples WHERE sample_id = $1",
      [req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Sample not found" });
    res.json(await enrichWithBoqInfo(result.rows[0], { full: true }));
  } catch (error) {
    console.error("Error fetching sample:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/sample/:id
// Only NEW inventory_id entries (not previously issued) trigger stock-outs.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/sample/{id}:
 *   put:
 *     summary: Update a sample (newly-added inventory_id/boq_id items auto stock-out / auto-consume)
 *     tags: [Sample]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: The sample_id to update
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               flats:            { type: string,  example: "A-101, A-102" }
 *               building_name:    { type: string,  example: "Block A" }
 *               site_name:        { type: string,  example: "Main Site" }
 *               location:
 *                 type: object
 *                 properties:
 *                   floor:        { type: string, example: "2nd" }
 *                   flat_no:      { type: string, example: "A-101" }
 *                   block:        { type: string, example: "B" }
 *                   wing:         { type: string, example: "East" }
 *                   coordinates:  { type: string, example: "19.0760,72.8777" }
 *               work_done:        { type: string, example: "Flooring" }
 *               item_description:
 *                 type: array
 *                 description: Full replacement list of item lines. Only items with a NEW (not previously issued) inventory_id/boq_id trigger a deduction.
 *                 items:
 *                   type: object
 *                   properties:
 *                     sr_no:          { type: integer, example: 1 }
 *                     item_name:      { type: string,  example: "Ceramic Tile" }
 *                     item_code:      { type: string,  example: "ITM-007" }
 *                     brand_name:     { type: string,  example: "Kajaria" }
 *                     description:    { type: string,  example: "60x60 Glossy White" }
 *                     specification:  { type: string,  example: "Grade A, ISO certified" }
 *                     unit:           { type: string,  example: "Nos" }
 *                     quantity:       { type: number,  example: 100 }
 *                     value:          { type: number,  example: 45.50 }
 *                     inventory_id:   { type: integer, example: 12, description: "Link to inventory item for auto stock-out" }
 *                     issued_qty:     { type: number,  example: 100, description: "Qty to deduct from inventory (defaults to quantity)" }
 *                     boq_id:         { type: integer, example: 7,  description: "Link to a BOQ item (boqs.boq_id) this sample line was taken from" }
 *                     boq_issued_qty: { type: number,  example: 100, description: "Qty to consume from the BOQ item's remaining quantity (defaults to quantity)" }
 *               add_fields:       { type: array }
 *               sample_file:      { type: string }
 *               project_name:     { type: string, description: "Used for movement/history logging only" }
 *               user_id:          { type: string, description: "Who is making this update" }
 *               user_name:        { type: string }
 *           example:
 *             sample_id: "SAMPLE-001"
 *             project_id: 1
 *             flats: "A-101, A-102"
 *             building_name: "Block A"
 *             site_name: "Main Site"
 *             location:
 *               floor: "2nd"
 *               flat_no: "A-101"
 *               block: "B"
 *               wing: "East"
 *               coordinates: "19.0760,72.8777"
 *             work_done: "Flooring"
 *             item_description:
 *               - sr_no: 1
 *                 item_name: "Ceramic Tile"
 *                 item_code: "ITM-007"
 *                 brand_name: "Kajaria"
 *                 description: "60x60 Glossy White"
 *                 specification: "Grade A, ISO certified"
 *                 unit: "Nos"
 *                 quantity: 100
 *                 value: 45.50
 *                 inventory_id: 12
 *                 issued_qty: 100
 *                 boq_id: 7
 *                 boq_issued_qty: 100
 *               - sr_no: 2
 *                 item_name: "Wall Putty"
 *                 brand_name: "Birla White"
 *                 description: "Interior Wall Putty 40kg"
 *                 specification: "White cement based"
 *                 unit: "Bags"
 *                 quantity: 20
 *                 value: 380
 *             add_fields: []
 *             user_id: "123"
 *             user_name: "John Doe"
 *             project_name: "Madhuram Towers"
 *     responses:
 *       200:
 *         description: Sample updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sample_id:        { type: string, example: "SAMPLE-001" }
 *                 project_id:       { type: integer, example: 1 }
 *                 flats:            { type: string,  example: "A-101, A-102" }
 *                 building_name:    { type: string,  example: "Block A" }
 *                 site_name:        { type: string,  example: "Main Site" }
 *                 location:         { type: object }
 *                 work_done:        { type: string, example: "Flooring" }
 *                 item_description:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       sr_no:          { type: integer }
 *                       item_name:      { type: string }
 *                       item_code:      { type: string }
 *                       brand_name:     { type: string }
 *                       description:    { type: string }
 *                       specification:  { type: string }
 *                       unit:           { type: string }
 *                       quantity:       { type: number }
 *                       value:          { type: number }
 *                       inventory_id:   { type: integer }
 *                       issued_qty:     { type: number }
 *                       inventory_issued: { type: boolean }
 *                       inventory_issued_at: { type: string, format: "date-time" }
 *                       boq_id:         { type: integer, description: "BOQ item this line was taken from" }
 *                       boq_issued_qty: { type: number }
 *                       boq_issued:     { type: boolean }
 *                       boq_issued_at:  { type: string, format: "date-time" }
 *                       boq_item_code:  { type: string, description: "item_code of the linked BOQ item (looked up live, not stored)" }
 *                       boq_description: { type: string, description: "description of the linked BOQ item (looked up live, not stored)" }
 *                       boq_remaining_quantity: { type: number, description: "Remaining quantity left on the linked BOQ item after this consumption" }
 *                 add_fields:       { type: array }
 *                 sample_file:      { type: string }
 *                 created_at:       { type: string, format: "date-time" }
 *                 updated_at:       { type: string, format: "date-time" }
 *       400:
 *         description: Insufficient inventory stock or bad data (BOQ quantity is never blocked — remaining_quantity can go negative)
 *       404:
 *         description: Not found
 *       500:
 *         description: Server error
 */
router.put("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { id } = req.params;
    const {
      flats, building_name, site_name, location,
      work_done, item_description, add_fields, sample_file,
    } = req.body;

    // Fetch existing sample to detect previously-issued items
    const existing = await client.query(
      "SELECT * FROM samples WHERE sample_id = $1",
      [id]
    );
    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Sample not found" });
    }
    const prev = existing.rows[0];
    const prevItems = Array.isArray(prev.item_description) ? prev.item_description : [];

    // Process stock-outs for any newly added inventory_id items
    const newItems = item_description || null;
    if (newItems) {
      await processInventoryItems(client, {
        items:           newItems,
        previous_items:  prevItems,
        sample_id:       id,
        sample_ref:      building_name || prev.building_name || `Sample #${id}`,
        project_id:      prev.project_id,
        project_name:    req.body.project_name || null,
        performed_by:    req.body.user_id || null,
        performed_by_name: req.body.user_name || null,
      });

      // Process BOQ consumption for any newly added boq_id items
      await processBoqItems(client, { items: newItems, previous_items: prevItems });
    }

    const result = await client.query(
      `UPDATE samples SET
         flats            = COALESCE($1, flats),
         building_name    = COALESCE($2, building_name),
         site_name        = COALESCE($3, site_name),
         location         = COALESCE($4, location),
         work_done        = COALESCE($5, work_done),
         item_description = COALESCE($6, item_description),
         add_fields       = COALESCE($7, add_fields),
         sample_file      = COALESCE($8, sample_file),
         updated_at       = CURRENT_TIMESTAMP
       WHERE sample_id = $9
       RETURNING *`,
      [
        flats || null,
        building_name || null,
        site_name || null,
        location ? JSON.stringify(location) : null,
        work_done || null,
        newItems ? JSON.stringify(newItems) : null,
        add_fields ? JSON.stringify(add_fields) : null,
        sample_file || null,
        id,
      ]
    );

    await client.query("COMMIT");

    logActivity({
      action: "updated", entity_type: "sample",
      entity_id: id,
      entity_name: result.rows[0].site_name || `Sample #${id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: result.rows[0].project_id,
      meta: { updates: req.body },
    });

    res.json(await enrichWithBoqInfo(result.rows[0]));
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error updating sample:", error.message);
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/sample/:id
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/sample/{id}:
 *   delete:
 *     summary: Delete a sample by sample ID (restores inventory if items were issued)
 *     tags: [Sample]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: The sample_id to delete (e.g. "SAMPLE-001")
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               user_id:      { type: string, format: uuid, description: "Who is deleting" }
 *               user_name:    { type: string }
 *               project_name: { type: string }
 *     responses:
 *       200:
 *         description: Sample deleted; inventory stock restored for any issued items
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:             { type: string, example: "Sample deleted" }
 *                 inventory_restored:  { type: boolean }
 *                 restored_items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       inventory_id:  { type: integer }
 *                       qty_restored:  { type: number }
 *       404:
 *         description: Sample not found
 *       500:
 *         description: Server error
 */
router.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── Step 1: fetch the sample so we have item_description ─────────────────
    const sampleRes = await client.query(
      "SELECT * FROM samples WHERE sample_id = $1",
      [req.params.id]
    );
    if (sampleRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Sample not found" });
    }
    const sample = sampleRes.rows[0];

    // ── Step 2: restore inventory for items that were issued ──────────────────
    // sample.item_description is JSONB — Postgres returns it as a JS array.
    const items = Array.isArray(sample.item_description) ? sample.item_description : [];
    const restoredItems = [];

    for (const item of items) {
      if (!item.inventory_id) continue;       // not linked to inventory → skip
      if (!item.inventory_issued) continue;   // was never deducted → skip

      const qty = Number(item.issued_qty ?? item.quantity ?? 0);
      if (qty <= 0) continue;

      await recordMovement(client, {
        inventory_id:      item.inventory_id,
        movement_type:     "in",              // stock back IN
        quantity:          qty,
        source_type:       "sample",
        source_id:         sample.sample_id,
        source_ref:        sample.building_name || `Sample #${req.params.id}`,
        project_id:        sample.project_id,
        project_name:      req.body.project_name || null,
        notes:             `Reversed: Sample #${req.params.id} (${sample.building_name || ""}) deleted`,
        performed_by:      req.body.user_id || null,
        performed_by_name: req.body.user_name || null,
      });

      restoredItems.push({ inventory_id: item.inventory_id, qty_restored: qty });
    }

    // ── Step 2b: restore BOQ used_quantity for items that were issued ─────────
    await restoreBoqItems(client, items);

    // ── Step 3: delete the sample ─────────────────────────────────────────────
    await client.query(
      "DELETE FROM samples WHERE sample_id = $1",
      [req.params.id]
    );

    await client.query("COMMIT");

    res.json({
      message: "Sample deleted",
      inventory_restored: restoredItems.length > 0,
      restored_items: restoredItems,
    });

    logActivity({
      action: "deleted", entity_type: "sample",
      entity_id: req.params.id,
      entity_name: sample.building_name || `Sample #${req.params.id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: sample.project_id,
      meta: {
        inventory_restored: restoredItems,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error deleting sample:", error);
    res.status(500).json({ error: "Internal Server Error" });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/sample/project/:projectId
//
// FIX: Also restores inventory for all samples under the project.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/sample/project/{projectId}:
 *   delete:
 *     summary: Delete all samples associated with a project_id (restores inventory)
 *     tags: [Sample]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Samples deleted successfully; inventory restored
 *       500:
 *         description: Server error
 */
router.delete("/project/:projectId", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { projectId } = req.params;

    // Fetch all samples for this project
    const samplesRes = await client.query(
      "SELECT * FROM samples WHERE project_id = $1",
      [projectId]
    );

    const allRestoredItems = [];

    // Restore inventory for each sample's issued items
    for (const sample of samplesRes.rows) {
      const items = Array.isArray(sample.item_description) ? sample.item_description : [];
      for (const item of items) {
        if (!item.inventory_id) continue;
        if (!item.inventory_issued) continue;
        const qty = Number(item.issued_qty ?? item.quantity ?? 0);
        if (qty <= 0) continue;

        await recordMovement(client, {
          inventory_id:      item.inventory_id,
          movement_type:     "in",
          quantity:          qty,
          source_type:       "sample",
          source_id:         sample.sample_id,
          source_ref:        sample.building_name || `Sample #${sample.sample_id}`,
          project_id:        Number(projectId),
          project_name:      req.body.project_name || null,
          notes:             `Reversed: Sample #${sample.sample_id} deleted (project #${projectId} bulk delete)`,
          performed_by:      req.body.user_id || null,
          performed_by_name: req.body.user_name || null,
        });

        allRestoredItems.push({
          sample_id: sample.sample_id,
          inventory_id: item.inventory_id,
          qty_restored: qty,
        });
      }

      // Restore BOQ used_quantity for this sample's items too
      await restoreBoqItems(client, items);
    }

    // Now delete all samples for the project
    const result = await client.query(
      "DELETE FROM samples WHERE project_id = $1 RETURNING sample_id",
      [projectId]
    );

    await client.query("COMMIT");

    res.json({
      message: `${result.rowCount} samples deleted for project_id ${projectId}`,
      deleted_count: result.rowCount,
      inventory_restored: allRestoredItems.length > 0,
      restored_items: allRestoredItems,
    });

    logActivity({
      action: "deleted_all_by_project",
      entity_type: "sample",
      entity_id: projectId,
      entity_name: `All samples for project #${projectId}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: projectId,
      meta: { deleted_count: result.rowCount, inventory_restored: allRestoredItems },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error deleting samples by project:", error);
    res.status(500).json({ error: "Internal Server Error" });
  } finally {
    client.release();
  }
});

module.exports = router;
