const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { logActivity, getEntityHistory, attachCreatedUpdatedBy } = require("./dashboard");
const { recordMovement } = require("./inventory"); // stock-out AND stock-in helper

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: scan item_description array and stock-out any item that carries
// an inventory_id. Safe to call on both CREATE and UPDATE.
// Mirrors processInventoryItems() in src/routes/sample.js, source_type "installation".
//
// item format (all optional — items without inventory_id are ignored):
//   {
//     sr_no, item_name, item_code, item_no, brand_name, description,
//     specification, unit, quantity, value,
//     inventory_id,   ← links to inventories table
//     issued_qty,     ← qty to deduct (falls back to `quantity`)
//   }
// ─────────────────────────────────────────────────────────────────────────────
async function processInventoryItems(client, {
  items,
  installation_id,
  installation_ref,
  project_id,
  project_name,
  performed_by,
  performed_by_name,
  // Pass previously stored items so we can detect newly-added inventory links
  previous_items = [],
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

    const qty = Number(item.issued_qty ?? item.quantity ?? 0);
    if (qty <= 0) continue;

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
      source_type:       "installation",
      source_id:         installation_id,
      source_ref:        installation_ref,
      project_id,
      project_name,
      notes:             `Consumed by Installation: ${installation_ref || `#${installation_id}`}`,
      performed_by,
      performed_by_name,
    });

    item.inventory_issued = true;
    item.inventory_issued_at = new Date().toISOString();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: reconcile "used_quantity" on any BOQ item referenced via boq_id
// against the item_description array being saved. Mirrors processBoqItems()
// in src/routes/sample.js — reconciles by DELTA every save so edits are
// correct in both directions.
//
// item format (all optional):
//   {
//     ...existing fields,
//     boq_id,          ← links to boqs table
//     boq_issued_qty,  ← qty to consume from that BOQ item (falls back to `quantity`)
//   }
// ─────────────────────────────────────────────────────────────────────────────
async function processBoqItems(client, { items, previous_items = [] }) {
  if (!Array.isArray(items)) return;

  const sumByBoq = (list) => {
    const map = new Map();
    for (const i of list) {
      if (!i.boq_id) continue;
      const boqId = Number(i.boq_id);
      const qty = Number(i.boq_issued_qty ?? i.quantity ?? 0);
      map.set(boqId, (map.get(boqId) || 0) + qty);
    }
    return map;
  };

  const prevQtyByBoq = sumByBoq(previous_items.filter(i => i.boq_issued));
  const newQtyByBoq  = sumByBoq(items);

  const allBoqIds = new Set([...prevQtyByBoq.keys(), ...newQtyByBoq.keys()]);

  for (const boqId of allBoqIds) {
    const oldQty = prevQtyByBoq.get(boqId) || 0;
    const newQty = newQtyByBoq.get(boqId) || 0;
    const delta = newQty - oldQty;
    if (delta === 0) continue;

    const boqRes = await client.query(
      "SELECT item_code, quantity, used_quantity FROM boqs WHERE boq_id = $1 FOR UPDATE",
      [boqId]
    );
    if (boqRes.rows.length === 0) {
      if (newQtyByBoq.has(boqId))
        throw new Error(`BOQ item ${boqId} not found`);
      continue;
    }

    // No hard block on insufficient quantity — BOQ quantities are planning
    // estimates, not a hard cap. remaining_quantity can go negative.
    await client.query(
      `UPDATE boqs
          SET used_quantity = GREATEST(COALESCE(used_quantity, 0) + $1, 0),
              updated_at = CURRENT_TIMESTAMP
        WHERE boq_id = $2`,
      [delta, boqId]
    );
  }

  for (const item of items) {
    if (!item.boq_id) continue;
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
// HELPER: enrich installation(s) item_description with the linked BOQ's
// item_code/description/quantities, without mutating what's stored in the DB.
// ─────────────────────────────────────────────────────────────────────────────
async function enrichWithBoqInfo(installations) {
  const list = Array.isArray(installations) ? installations : [installations];

  const boqIds = new Set();
  list.forEach(inst => {
    const items = Array.isArray(inst.item_description) ? inst.item_description : [];
    items.forEach(i => {
      const n = Number(i.boq_id);
      if (i.boq_id && Number.isFinite(n)) boqIds.add(n);
    });
  });

  let boqMap = new Map();
  if (boqIds.size > 0) {
    const boqRes = await pool.query(
      `SELECT boq_id, item_code, description, unit, quantity, used_quantity
         FROM boqs WHERE boq_id = ANY($1)`,
      [[...boqIds]]
    );
    boqMap = new Map(boqRes.rows.map(b => [b.boq_id, b]));
  }

  const enriched = list.map(inst => {
    const items = Array.isArray(inst.item_description) ? inst.item_description : [];
    const enrichedItems = items.map(i => {
      if (!i.boq_id) return i;
      const boq = boqMap.get(Number(i.boq_id));
      if (!boq) return i;
      return {
        ...i,
        boq_item_code: boq.item_code,
        boq_description: boq.description,
        boq_total_quantity: Number(boq.quantity || 0),
        boq_used_quantity: Number(boq.used_quantity || 0),
        boq_remaining_quantity: Number(boq.quantity || 0) - Number(boq.used_quantity || 0),
      };
    });
    return { ...inst, item_description: enrichedItems };
  });

  const withCreatedUpdatedBy = await attachCreatedUpdatedBy(enriched, "installation", (r) => r.installation_id);

  return Array.isArray(installations) ? withCreatedUpdatedBy : withCreatedUpdatedBy[0];
}

/**
 * @swagger
 * tags:
 *   name: Installation
 *   description: Installation management (mirrors Sample — inventory auto stock-out and BOQ auto-consumption when items carry inventory_id / boq_id)
 */

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/installation
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/installation:
 *   post:
 *     summary: Create an installation (inventory auto stock-out / BOQ auto-consume if inventory_id / boq_id in items)
 *     tags: [Installation]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - installation_id
 *               - project_id
 *             properties:
 *               installation_id:  { type: string, example: "INSTALL-001", description: "Unique installation ID provided by the frontend (can be alphanumeric)" }
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
 *                     item_name:     { type: string,  example: "Ceramic Tile" }
 *                     item_code:     { type: string,  example: "ITM-007" }
 *                     item_no:       { type: string,  example: "ITM-007" }
 *                     brand_name:    { type: string,  example: "Kajaria" }
 *                     description:   { type: string,  example: "60x60 Glossy White" }
 *                     specification: { type: string,  example: "Grade A, ISO certified" }
 *                     unit:          { type: string,  example: "Nos" }
 *                     quantity:      { type: number,  example: 100 }
 *                     value:         { type: number,  example: 45.50 }
 *                     inventory_id:  { type: integer, example: 12,   description: "Link to inventory item for auto stock-out" }
 *                     issued_qty:    { type: number,  example: 100,  description: "Qty to deduct from inventory (defaults to quantity)" }
 *                     boq_id:        { type: integer, example: 7,    description: "Link to a BOQ item (boqs.boq_id)" }
 *                     boq_issued_qty: { type: number, example: 100,  description: "Qty to consume from the BOQ item's remaining quantity (defaults to quantity)" }
 *               add_fields:       { type: array }
 *     responses:
 *       201:
 *         description: Installation created; linked inventory/BOQ items auto-deducted
 *       400:
 *         description: Insufficient inventory stock, invalid project_id, or bad data
 *       500:
 *         description: Server error
 */
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const {
      installation_id, project_id, flats, building_name, site_name,
      location, work_done, item_description, add_fields,
    } = req.body;

    if (!installation_id) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "installation_id is required and must be provided by the client" });
    }

    const result = await client.query(
      `INSERT INTO installations
         (installation_id, project_id, flats, building_name, site_name, location, work_done, item_description, add_fields)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        installation_id,
        project_id, flats || null, building_name, site_name,
        location ? JSON.stringify(location) : null,
        work_done,
        item_description ? JSON.stringify(item_description) : JSON.stringify([]),
        add_fields ? JSON.stringify(add_fields) : JSON.stringify([]),
      ]
    );

    const installation = result.rows[0];

    const items = item_description || [];
    await processInventoryItems(client, {
      items,
      installation_id:   installation.installation_id,
      installation_ref:  building_name || `Installation #${installation.installation_id}`,
      project_id,
      project_name:      req.body.project_name || null,
      performed_by:      req.body.created_by || req.body.user_id || null,
      performed_by_name: req.body.created_by_name || req.body.user_name || null,
    });

    await processBoqItems(client, { items });

    if (items.some(i => i.inventory_issued || i.boq_issued)) {
      await client.query(
        "UPDATE installations SET item_description = $1 WHERE installation_id = $2",
        [JSON.stringify(items), installation.installation_id]
      );
      installation.item_description = items;
    }

    await client.query("COMMIT");

    logActivity({
      action: "created", entity_type: "installation",
      entity_id: installation.installation_id,
      entity_name: building_name || `Installation #${installation.installation_id}`,
      performed_by: req.body.created_by || null,
      performed_by_name: req.body.created_by_name || null,
      meta: { project_id },
    });

    res.status(201).json(await enrichWithBoqInfo(installation));
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error creating installation:", error.message);
    if (error.code === "23503")
      return res.status(400).json({ error: "Invalid project_id: Project does not exist" });
    if (error.code === "23505")
      return res.status(400).json({ error: "installation_id already exists" });
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/installation
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/installation:
 *   get:
 *     summary: Get all installations
 *     tags: [Installation]
 *     responses:
 *       200:
 *         description: List of all installations
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM installations ORDER BY created_at DESC");
    const installations = result.rows.map(inst => {
      const items = Array.isArray(inst.item_description) ? inst.item_description : [];
      const linked = items.length > 0 && items.every(i => i.inventory_id);
      return { ...inst, linked };
    });
    res.json(await enrichWithBoqInfo(installations));
  } catch (error) {
    console.error("Error fetching installations:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/installation/project/:projectId
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/installation/project/{projectId}:
 *   get:
 *     summary: Get all installations for a specific project
 *     tags: [Installation]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: List of installations for the project
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
      "SELECT * FROM installations WHERE project_id = $1 ORDER BY created_at DESC",
      [projectId]
    );
    const installations = result.rows.map(inst => {
      const items = Array.isArray(inst.item_description) ? inst.item_description : [];
      const linked = items.length > 0 && items.every(i => i.inventory_id);
      return { ...inst, linked };
    });
    res.json(await enrichWithBoqInfo(installations));
  } catch (error) {
    console.error("Error fetching installations by project:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/installation/:id
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/installation/{id}:
 *   get:
 *     summary: Get a single installation by ID
 *     tags: [Installation]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Installation details
 *       404:
 *         description: Not found
 */
router.get("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM installations WHERE installation_id = $1",
      [req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Installation not found" });
    res.json(await enrichWithBoqInfo(result.rows[0]));
  } catch (error) {
    console.error("Error fetching installation:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/installation/:id
// Only NEW inventory_id/boq_id entries (not previously issued) trigger deductions.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/installation/{id}:
 *   put:
 *     summary: Update an installation (newly-added inventory_id/boq_id items auto stock-out / auto-consume)
 *     tags: [Installation]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: The installation_id to update
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               flats:            { type: string }
 *               building_name:    { type: string }
 *               site_name:        { type: string }
 *               location:         { type: object }
 *               work_done:        { type: string }
 *               item_description: { type: array, items: { type: object } }
 *               add_fields:       { type: array }
 *               project_name:     { type: string, description: "Used for movement/history logging only" }
 *               user_id:          { type: string }
 *               user_name:        { type: string }
 *     responses:
 *       200:
 *         description: Installation updated
 *       400:
 *         description: Insufficient inventory stock or bad data
 *       404:
 *         description: Not found
 */
router.put("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { id } = req.params;
    const {
      flats, building_name, site_name, location,
      work_done, item_description, add_fields,
    } = req.body;

    const existing = await client.query(
      "SELECT * FROM installations WHERE installation_id = $1",
      [id]
    );
    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Installation not found" });
    }
    const prev = existing.rows[0];
    const prevItems = Array.isArray(prev.item_description) ? prev.item_description : [];

    const newItems = item_description || null;
    if (newItems) {
      await processInventoryItems(client, {
        items:             newItems,
        previous_items:    prevItems,
        installation_id:   id,
        installation_ref:  building_name || prev.building_name || `Installation #${id}`,
        project_id:        prev.project_id,
        project_name:      req.body.project_name || null,
        performed_by:      req.body.user_id || null,
        performed_by_name: req.body.user_name || null,
      });

      await processBoqItems(client, { items: newItems, previous_items: prevItems });
    }

    const result = await client.query(
      `UPDATE installations SET
         flats            = COALESCE($1, flats),
         building_name    = COALESCE($2, building_name),
         site_name        = COALESCE($3, site_name),
         location         = COALESCE($4, location),
         work_done        = COALESCE($5, work_done),
         item_description = COALESCE($6, item_description),
         add_fields       = COALESCE($7, add_fields),
         updated_at       = CURRENT_TIMESTAMP
       WHERE installation_id = $8
       RETURNING *`,
      [
        flats || null,
        building_name || null,
        site_name || null,
        location ? JSON.stringify(location) : null,
        work_done || null,
        newItems ? JSON.stringify(newItems) : null,
        add_fields ? JSON.stringify(add_fields) : null,
        id,
      ]
    );

    await client.query("COMMIT");

    logActivity({
      action: "updated", entity_type: "installation",
      entity_id: id,
      entity_name: result.rows[0].site_name || `Installation #${id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: result.rows[0].project_id,
      meta: { updates: req.body },
    });

    res.json(await enrichWithBoqInfo(result.rows[0]));
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error updating installation:", error.message);
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/installation/:id
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/installation/{id}:
 *   delete:
 *     summary: Delete an installation (restores inventory/BOQ if items were issued)
 *     tags: [Installation]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: The installation_id to delete
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               user_id:      { type: string }
 *               user_name:    { type: string }
 *               project_name: { type: string }
 *     responses:
 *       200:
 *         description: Installation deleted; inventory stock restored for any issued items
 *       404:
 *         description: Not found
 *       500:
 *         description: Server error
 */
router.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const instRes = await client.query(
      "SELECT * FROM installations WHERE installation_id = $1",
      [req.params.id]
    );
    if (instRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Installation not found" });
    }
    const installation = instRes.rows[0];

    const items = Array.isArray(installation.item_description) ? installation.item_description : [];
    const restoredItems = [];

    for (const item of items) {
      if (!item.inventory_id) continue;
      if (!item.inventory_issued) continue;

      const qty = Number(item.issued_qty ?? item.quantity ?? 0);
      if (qty <= 0) continue;

      await recordMovement(client, {
        inventory_id:      item.inventory_id,
        movement_type:     "in",
        quantity:          qty,
        source_type:       "installation",
        source_id:         installation.installation_id,
        source_ref:        installation.building_name || `Installation #${req.params.id}`,
        project_id:        installation.project_id,
        project_name:      req.body.project_name || null,
        notes:             `Reversed: Installation #${req.params.id} (${installation.building_name || ""}) deleted`,
        performed_by:      req.body.user_id || null,
        performed_by_name: req.body.user_name || null,
      });

      restoredItems.push({ inventory_id: item.inventory_id, qty_restored: qty });
    }

    await restoreBoqItems(client, items);

    await client.query(
      "DELETE FROM installations WHERE installation_id = $1",
      [req.params.id]
    );

    await client.query("COMMIT");

    res.json({
      message: "Installation deleted",
      inventory_restored: restoredItems.length > 0,
      restored_items: restoredItems,
    });

    logActivity({
      action: "deleted", entity_type: "installation",
      entity_id: req.params.id,
      entity_name: installation.building_name || `Installation #${req.params.id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: installation.project_id,
      meta: { inventory_restored: restoredItems },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error deleting installation:", error);
    res.status(500).json({ error: "Internal Server Error" });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/installation/project/:projectId
// Restores inventory/BOQ for every installation under the project.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/installation/project/{projectId}:
 *   delete:
 *     summary: Delete all installations associated with a project_id (restores inventory/BOQ)
 *     tags: [Installation]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Installations deleted successfully; inventory/BOQ restored
 *       500:
 *         description: Server error
 */
router.delete("/project/:projectId", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { projectId } = req.params;

    const installationsRes = await client.query(
      "SELECT * FROM installations WHERE project_id = $1",
      [projectId]
    );

    const allRestoredItems = [];

    for (const installation of installationsRes.rows) {
      const items = Array.isArray(installation.item_description) ? installation.item_description : [];
      for (const item of items) {
        if (!item.inventory_id) continue;
        if (!item.inventory_issued) continue;
        const qty = Number(item.issued_qty ?? item.quantity ?? 0);
        if (qty <= 0) continue;

        await recordMovement(client, {
          inventory_id:      item.inventory_id,
          movement_type:     "in",
          quantity:          qty,
          source_type:       "installation",
          source_id:         installation.installation_id,
          source_ref:        installation.building_name || `Installation #${installation.installation_id}`,
          project_id:        Number(projectId),
          project_name:      req.body.project_name || null,
          notes:             `Reversed: Installation #${installation.installation_id} deleted (project #${projectId} bulk delete)`,
          performed_by:      req.body.user_id || null,
          performed_by_name: req.body.user_name || null,
        });

        allRestoredItems.push({
          installation_id: installation.installation_id,
          inventory_id: item.inventory_id,
          qty_restored: qty,
        });
      }

      await restoreBoqItems(client, items);
    }

    const result = await client.query(
      "DELETE FROM installations WHERE project_id = $1 RETURNING installation_id",
      [projectId]
    );

    await client.query("COMMIT");

    res.json({
      message: `${result.rowCount} installations deleted for project_id ${projectId}`,
      deleted_count: result.rowCount,
      inventory_restored: allRestoredItems.length > 0,
      restored_items: allRestoredItems,
    });

    logActivity({
      action: "deleted_all_by_project",
      entity_type: "installation",
      entity_id: projectId,
      entity_name: `All installations for project #${projectId}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: projectId,
      meta: { deleted_count: result.rowCount, inventory_restored: allRestoredItems },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error deleting installations by project:", error);
    res.status(500).json({ error: "Internal Server Error" });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/installation/:id/history — who created/updated/deleted this installation, and when
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/installation/{id}/history:
 *   get:
 *     summary: Get the create/update/delete history for an installation (who did what, and when)
 *     tags: [Installation]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *       - in: query
 *         name: offset
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Activity history for this installation
 */
router.get("/:id/history", async (req, res) => {
  try {
    const data = await getEntityHistory("installation", req.params.id, {
      limit: req.query.limit, offset: req.query.offset,
    });
    res.json(data);
  } catch (error) {
    console.error("Error fetching installation history:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
