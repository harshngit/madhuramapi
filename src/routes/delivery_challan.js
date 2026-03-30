const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const { logActivity } = require("./dashboard");
const fs = require("fs");
const { recordMovement } = require("./inventory"); // ← new import

// Ensure upload directory exists
const uploadDir = path.join(__dirname, "../../uploads/dc");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: push DC items into inventory
// ─────────────────────────────────────────────────────────────────────────────
async function syncDCToInventory(client, {
  dc_id,
  challan_number,
  po_id,
  project_id,
  project_name,
  items,
  performed_by,
  performed_by_name,
}) {
  if (!Array.isArray(items) || items.length === 0) return;

  for (const item of items) {
    const qty    = Number(item.quantity)  || 0;
    const price  = Number(item.price)    || 0;
    const name   = item.name             || item.description || "Unnamed Item";
    const units  = item.unit             || item.units       || null;
    const width  = Number(item.width)    || null;
    const height = Number(item.height) || Number(item.length) || null;

    if (qty <= 0) continue; // skip zero-qty lines

    // Check if this item (same name + dc) already exists in inventory
    const existing = await client.query(
      `SELECT inventory_id, current_quantity
         FROM inventories
        WHERE name = $1
          AND source_dc_id = $2
        LIMIT 1`,
      [name, dc_id]
    );

    let inventory_id;

    if (existing.rows.length > 0) {
      // Already exists – just record a stock-in movement (partial delivery re-sync)
      inventory_id = existing.rows[0].inventory_id;
    } else {
      // Create new inventory row
      const ins = await client.query(
        `INSERT INTO inventories
           (name, quantity, current_quantity, price, units, width, height,
            stockin, billing, project_id,
            source_dc_id, source_po_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,FALSE,$8,$9,$10)
         RETURNING inventory_id`,
        [
          name, qty, 0, // current_quantity starts at 0, recordMovement will update it
          price, units, width, height,
          project_id || null,
          dc_id, po_id || null,
        ]
      );
      inventory_id = ins.rows[0].inventory_id;
    }

    // Record the stock-in movement
    await recordMovement(client, {
      inventory_id,
      movement_type: "in",
      quantity:      qty,
      source_type:   "dc",
      source_id:     dc_id,
      source_ref:    challan_number,
      project_id,
      project_name,
      notes:         `Auto stock-in from Delivery Challan ${challan_number}`,
      performed_by,
      performed_by_name,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/dc/upload
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/dc/upload:
 *   post:
 *     summary: Upload a file for Delivery Challan
 *     tags: [DeliveryChallan]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: File uploaded
 *       400:
 *         description: No file uploaded
 */
router.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const filePath = `/uploads/dc/${req.file.filename}`;
  res.json({ filePath });

  if (req.body.user_id) {
    logActivity({
      action: "uploaded", entity_type: "dc_file",
      entity_id: null, entity_name: req.file.originalname,
      performed_by: req.body.user_id, performed_by_name: req.body.user_name || null,
      meta: { filePath },
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/dc  – Create Delivery Challan + auto-sync items to inventory
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/dc:
 *   post:
 *     summary: Create a Delivery Challan (items auto-added to inventory)
 *     tags: [DeliveryChallan]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [project_id, challan_number, items]
 *             properties:
 *               project_id:       { type: integer }
 *               project_name:     { type: string }
 *               po_id:            { type: integer }
 *               po_number:        { type: string }
 *               challan_number:   { type: string }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     name:        { type: string }
 *                     description: { type: string }
 *                     width:       { type: number }
 *                     length:      { type: number }
 *                     quantity:    { type: number }
 *                     price:       { type: number }
 *                     unit:        { type: string }
 *               challan_date:     { type: string, format: date }
 *               work_order_number:{ type: string }
 *               order_date:       { type: string, format: date }
 *               auto_sync_inventory: { type: boolean, default: true }
 *     responses:
 *       201:
 *         description: Delivery Challan created; items added to inventory
 *       400:
 *         description: Bad request
 *       500:
 *         description: Server error
 */
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const {
      project_id, project_name,
      po_id, po_number,
      challan_number, items,
      challan_date, work_order_number, order_date,
      auto_sync_inventory = true,   // ← default true; pass false to skip
      user_id, user_name,
    } = req.body;

    if (!project_id || !challan_number || !Array.isArray(items)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "project_id, challan_number and items are required" });
    }

    // ── Resolve PO item count for status calc ────────────────────────────────
    let total_po_items = null;
    let resolved_po_id = po_id || null;

    if (po_id) {
      const poRes = await client.query(
        "SELECT jsonb_array_length(items) AS cnt FROM pos WHERE po_id = $1",
        [po_id]
      );
      total_po_items = poRes.rows.length ? poRes.rows[0].cnt : null;
    } else if (po_number) {
      const poRes = await client.query(
        "SELECT po_id, jsonb_array_length(items) AS cnt FROM pos WHERE order_no=$1 AND project_id=$2 LIMIT 1",
        [po_number, project_id]
      );
      if (poRes.rows.length) {
        resolved_po_id = poRes.rows[0].po_id;
        total_po_items = poRes.rows[0].cnt;
      }
    }

    const total_challan_items = items.length;
    const status = total_po_items !== null && total_po_items === total_challan_items
      ? "completed"
      : "incomplete";

    // ── Insert DC ─────────────────────────────────────────────────────────────
    const dcRes = await client.query(
      `INSERT INTO delivery_challans
         (project_id, po_id, po_number, challan_number, items, challan_date,
          work_order_number, order_date, total_po_items, total_challan_items,
          status, inventory_synced, inventory_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        project_id, resolved_po_id || null, po_number || null,
        challan_number, JSON.stringify(items),
        challan_date || null, work_order_number || null, order_date || null,
        total_po_items, total_challan_items, status,
        auto_sync_inventory ? true : false,
        auto_sync_inventory ? new Date() : null,
      ]
    );

    const dc = dcRes.rows[0];

    // ── Auto-sync items to inventory ─────────────────────────────────────────
    if (auto_sync_inventory) {
      await syncDCToInventory(client, {
        dc_id:            dc.dc_id,
        challan_number,
        po_id:            resolved_po_id,
        project_id,
        project_name:     project_name || null,
        items,
        performed_by:     user_id    || null,
        performed_by_name: user_name || null,
      });
    }

    await client.query("COMMIT");

    res.status(201).json({
      ...dc,
      inventory_synced: auto_sync_inventory,
    });

    logActivity({
      action: "created", entity_type: "delivery_challan",
      entity_id: dc.dc_id, entity_name: challan_number,
      performed_by: user_id || null, performed_by_name: user_name || null,
      project_id,
      meta: { po_id: resolved_po_id, po_number, inventory_synced: auto_sync_inventory },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error creating Delivery Challan:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/dc/:id/sync-inventory  – manually trigger inventory sync for a DC
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/dc/{id}/sync-inventory:
 *   post:
 *     summary: Manually sync a Delivery Challan's items into inventory
 *     tags: [DeliveryChallan]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Inventory synced successfully
 *       404:
 *         description: DC not found
 *       409:
 *         description: Already synced
 */
router.post("/:id/sync-inventory", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { id } = req.params;
    const { user_id, user_name, force = false } = req.body;

    const dcRes = await client.query(
      "SELECT * FROM delivery_challans WHERE dc_id = $1",
      [id]
    );
    if (dcRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Delivery Challan not found" });
    }

    const dc = dcRes.rows[0];

    if (dc.inventory_synced && !force) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Inventory already synced for this DC. Pass force:true to re-sync.",
        synced_at: dc.inventory_synced_at,
      });
    }

    await syncDCToInventory(client, {
      dc_id:            dc.dc_id,
      challan_number:   dc.challan_number,
      po_id:            dc.po_id,
      project_id:       dc.project_id,
      project_name:     req.body.project_name || null,
      items:            dc.items,
      performed_by:     user_id    || null,
      performed_by_name: user_name || null,
    });

    await client.query(
      "UPDATE delivery_challans SET inventory_synced=TRUE, inventory_synced_at=NOW() WHERE dc_id=$1",
      [id]
    );

    await client.query("COMMIT");

    res.json({ message: "Inventory synced successfully", dc_id: id });

    logActivity({
      action: "inventory_synced", entity_type: "delivery_challan",
      entity_id: id, entity_name: dc.challan_number,
      performed_by: user_id || null, performed_by_name: user_name || null,
      project_id: dc.project_id, meta: { forced: force },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error syncing inventory:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/dc/project/:projectId
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/dc/project/{projectId}:
 *   get:
 *     summary: Get all Delivery Challans for a project
 *     tags: [DeliveryChallan]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: List of Delivery Challans
 */
router.get("/project/:projectId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM delivery_challans WHERE project_id=$1 ORDER BY created_at DESC",
      [req.params.projectId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching DCs:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/dc/po/:poId
// ─────────────────────────────────────────────────────────────────────────────
router.get("/po/:poId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM delivery_challans WHERE po_id=$1 ORDER BY created_at DESC",
      [req.params.poId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching DCs by PO:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/dc/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM delivery_challans WHERE dc_id=$1",
      [req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Delivery Challan not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching DC:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/dc/:id  (metadata update – does NOT re-sync inventory automatically)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/dc/{id}:
 *   put:
 *     summary: Update a Delivery Challan (metadata only)
 *     tags: [DeliveryChallan]
 *     description: |
 *       Updates DC fields. If items are changed and you want to re-sync inventory,
 *       call POST /api/dc/{id}/sync-inventory with force:true afterwards.
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
    project_id, po_id, po_number, challan_number,
    items, challan_date, work_order_number, order_date,
  } = req.body;

  try {
    const existRes = await pool.query(
      "SELECT * FROM delivery_challans WHERE dc_id=$1",
      [id]
    );
    if (existRes.rows.length === 0)
      return res.status(404).json({ error: "Delivery Challan not found" });

    const cur = existRes.rows[0];
    const next_po_id   = po_id   !== undefined ? po_id   : cur.po_id;
    const next_items   = items   !== undefined ? items   : cur.items;

    let total_po_items = cur.total_po_items;
    if (next_po_id) {
      const poRes = await pool.query(
        "SELECT jsonb_array_length(items) AS cnt FROM pos WHERE po_id=$1",
        [next_po_id]
      );
      if (poRes.rows.length) total_po_items = poRes.rows[0].cnt;
    }

    const total_challan_items = Array.isArray(next_items) ? next_items.length : (cur.total_challan_items || 0);
    const status = total_po_items !== null && total_po_items === total_challan_items
      ? "completed" : "incomplete";

    const result = await pool.query(
      `UPDATE delivery_challans SET
         project_id          = COALESCE($1,  project_id),
         po_id               = COALESCE($2,  po_id),
         po_number           = COALESCE($3,  po_number),
         challan_number      = COALESCE($4,  challan_number),
         items               = COALESCE($5,  items),
         challan_date        = COALESCE($6,  challan_date),
         work_order_number   = COALESCE($7,  work_order_number),
         order_date          = COALESCE($8,  order_date),
         total_po_items      = $9,
         total_challan_items = $10,
         status              = $11,
         updated_at          = CURRENT_TIMESTAMP
       WHERE dc_id = $12 RETURNING *`,
      [
        project_id || null, po_id || null, po_number || null, challan_number || null,
        items ? JSON.stringify(items) : null,
        challan_date || null, work_order_number || null, order_date || null,
        total_po_items, total_challan_items, status, id,
      ]
    );

    res.json(result.rows[0]);

    logActivity({
      action: "updated", entity_type: "delivery_challan",
      entity_id: id, entity_name: result.rows[0].challan_number,
      performed_by: req.body.user_id || null, performed_by_name: req.body.user_name || null,
      project_id: result.rows[0].project_id, meta: { updates: req.body },
    });
  } catch (err) {
    console.error("Error updating DC:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/dc/:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM delivery_challans WHERE dc_id=$1 RETURNING *",
      [req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Delivery Challan not found" });

    res.json({ message: "Delivery Challan deleted successfully" });

    logActivity({
      action: "deleted", entity_type: "delivery_challan",
      entity_id: req.params.id, entity_name: result.rows[0].challan_number,
      performed_by: req.body.user_id || null, performed_by_name: req.body.user_name || null,
      project_id: result.rows[0].project_id, meta: {},
    });
  } catch (err) {
    console.error("Error deleting DC:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;