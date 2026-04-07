const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { logActivity } = require("./dashboard");
const { recordMovement } = require("./inventory"); // ← stock-out helper

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
 *             properties:
 *               project_id:       { type: integer }
 *               building_name:    { type: string }
 *               site_name:        { type: string }
 *               location:         { type: object }
 *               work_done:        { type: string }
 *               item_description:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     sr_no:         { type: integer }
 *                     description:   { type: string }
 *                     quantity:      { type: number }
 *                     value:         { type: number }
 *                     inventory_id:  { type: integer, description: "Link to inventory item" }
 *                     issued_qty:    { type: number,  description: "Qty to deduct from inventory (default: quantity)" }
 *               add_fields:       { type: array }
 *     responses:
 *       201:
 *         description: Sample created; linked inventory items deducted
 *       400:
 *         description: Insufficient stock or bad data
 *       500:
 *         description: Server error
 */
router.post("/create-sample", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const {
      project_id, building_name, site_name,
      location, work_done, item_description, add_fields,
    } = req.body;

    // Insert sample first so we have sample_id for movement source_ref
    const result = await client.query(
      `INSERT INTO samples
         (project_id, building_name, site_name, location, work_done, item_description, add_fields)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        project_id, building_name, site_name,
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

    // If any items were marked inventory_issued, update the stored JSONB
    if (items.some(i => i.inventory_issued)) {
      await client.query(
        "UPDATE samples SET item_description = $1 WHERE sample_id = $2",
        [JSON.stringify(items), sample.sample_id]
      );
      sample.item_description = items;
    }

    await client.query("COMMIT");
    res.status(201).json(sample);

    logActivity({
      action: "created", entity_type: "sample",
      entity_id: sample.sample_id,
      entity_name: building_name || `Sample #${sample.sample_id}`,
      performed_by: req.body.created_by || null,
      performed_by_name: req.body.created_by_name || null,
      meta: { project_id },
    });
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
 *     tags: [Sample]
 *     responses:
 *       200:
 *         description: List of all samples
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { type: object }
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM samples ORDER BY created_at DESC");
    const samples = result.rows.map(s => {
      const items = Array.isArray(s.item_description) ? s.item_description : [];
      const linked = items.length > 0 && items.every(i => i.inventory_id);
      return { ...s, linked };
    });
    res.json(samples);
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
 *     tags: [Sample]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: List of samples for the project
 *       500:
 *         description: Server error
 */
router.get("/project/:projectId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM samples WHERE project_id = $1 ORDER BY created_at DESC",
      [req.params.projectId]
    );
    const samples = result.rows.map(s => {
      const items = Array.isArray(s.item_description) ? s.item_description : [];
      const linked = items.length > 0 && items.every(i => i.inventory_id);
      return { ...s, linked };
    });
    res.json(samples);
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
 *     summary: Get a single sample by ID
 *     tags: [Sample]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Sample details
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
    res.json(result.rows[0]);
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
 *     summary: Update a sample (new inventory_id items auto stock-out)
 *     tags: [Sample]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Sample updated
 *       404:
 *         description: Not found
 */
router.put("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { id } = req.params;
    const {
      building_name, site_name, location,
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
        sample_id:       Number(id),
        sample_ref:      building_name || prev.building_name || `Sample #${id}`,
        project_id:      prev.project_id,
        project_name:    req.body.project_name || null,
        performed_by:    req.body.user_id || null,
        performed_by_name: req.body.user_name || null,
      });
    }

    const result = await client.query(
      `UPDATE samples SET
         building_name    = COALESCE($1, building_name),
         site_name        = COALESCE($2, site_name),
         location         = COALESCE($3, location),
         work_done        = COALESCE($4, work_done),
         item_description = COALESCE($5, item_description),
         add_fields       = COALESCE($6, add_fields),
         sample_file      = COALESCE($7, sample_file),
         updated_at       = CURRENT_TIMESTAMP
       WHERE sample_id = $8
       RETURNING *`,
      [
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
    res.json(result.rows[0]);

    logActivity({
      action: "updated", entity_type: "sample",
      entity_id: id,
      entity_name: result.rows[0].site_name || `Sample #${id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: result.rows[0].project_id,
      meta: { updates: req.body },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error updating sample:", error.message);
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/sample/:id  (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM samples WHERE sample_id = $1 RETURNING *",
      [req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Sample not found" });

    res.json({ message: "Sample deleted" });

    logActivity({
      action: "deleted", entity_type: "sample",
      entity_id: req.params.id,
      entity_name: result.rows[0].building_name || `Sample #${req.params.id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: result.rows[0].project_id,
      meta: {},
    });
  } catch (error) {
    console.error("Error deleting sample:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/sample/project/:projectId
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/sample/project/{projectId}:
 *   delete:
 *     summary: Delete all samples associated with a project_id
 *     tags: [Sample]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Samples deleted successfully
 *       500:
 *         description: Server error
 */
router.delete("/project/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;
    const result = await pool.query(
      "DELETE FROM samples WHERE project_id = $1 RETURNING *",
      [projectId]
    );

    res.json({
      message: `${result.rowCount} samples deleted for project_id ${projectId}`,
      deleted_count: result.rowCount
    });

    logActivity({
      action: "deleted_all_by_project",
      entity_type: "sample",
      entity_id: projectId,
      entity_name: `All samples for project #${projectId}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: projectId,
      meta: { deleted_count: result.rowCount },
    });
  } catch (error) {
    console.error("Error deleting samples by project:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;