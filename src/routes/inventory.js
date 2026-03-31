const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { logActivity } = require("./dashboard");
const { logInventoryHistory } = require("./inventory_history"); // ← NEW

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: record a movement + update current_quantity on inventories
// ─────────────────────────────────────────────────────────────────────────────
async function recordMovement(client, {
  inventory_id,
  movement_type,   // 'in' | 'out' | 'adjustment'
  quantity,        // always positive; direction is set by movement_type
  source_type,     // 'dc' | 'po' | 'pr' | 'sample' | 'mir' | 'manual'
  source_id,
  source_ref,
  project_id,
  project_name,
  notes,
  performed_by,
  performed_by_name,
}) {
  const delta = movement_type === "out" ? -Math.abs(quantity) : Math.abs(quantity);

  // Get balance BEFORE update
  const beforeRes = await client.query(
    `SELECT current_quantity, name, brand, units FROM inventories WHERE inventory_id = $1`,
    [inventory_id]
  );
  const balance_before = Number(beforeRes.rows[0]?.current_quantity ?? 0);
  const item_name      = beforeRes.rows[0]?.name  || null;
  const item_brand     = beforeRes.rows[0]?.brand || null;
  const item_units     = beforeRes.rows[0]?.units || null;

  // Update current_quantity
  const updRes = await client.query(
    `UPDATE inventories
        SET current_quantity = COALESCE(current_quantity, 0) + $1,
            updated_at = CURRENT_TIMESTAMP
      WHERE inventory_id = $2
      RETURNING current_quantity`,
    [delta, inventory_id]
  );
  const balance_after = Number(updRes.rows[0]?.current_quantity ?? 0);

  // Insert into inventory_movements (existing table)
  await client.query(
    `INSERT INTO inventory_movements
       (inventory_id, movement_type, quantity, balance_after,
        source_type, source_id, source_ref,
        project_id, project_name, notes,
        performed_by, performed_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      inventory_id, movement_type, Math.abs(quantity), balance_after,
      source_type || null, source_id || null, source_ref || null,
      project_id  || null, project_name || null, notes || null,
      performed_by || null, performed_by_name || null,
    ]
  );

  // ── NEW: also log into inventory_history ──────────────────────────────────
  await logInventoryHistory(client, {
    inventory_id,
    item_name,
    item_brand,
    item_units,
    change_type:   movement_type === "in" ? "stock_in" : movement_type === "out" ? "stock_out" : "adjustment",
    stock_in:      movement_type === "in"  ? Math.abs(quantity) : 0,
    stock_out:     movement_type === "out" ? Math.abs(quantity) : 0,
    balance_before,
    balance_after,
    source_type:   source_type || "manual",
    source_id,
    source_ref,
    project_id,
    project_name,
    notes,
    performed_by,
    performed_by_name,
  });

  return balance_after;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inventory  – create item
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/inventory:
 *   post:
 *     summary: Create a new inventory item
 *     tags: [Inventory]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               brand:        { type: string }
 *               quantity:     { type: number }
 *               name:         { type: string }
 *               price:        { type: number }
 *               stockin:      { type: boolean }
 *               billing:      { type: boolean }
 *               units:        { type: string }
 *               width:        { type: number }
 *               height:       { type: number }
 *               project_id:   { type: integer }
 *               source_dc_id: { type: integer }
 *               source_po_id: { type: integer }
 *               source_pr_id: { type: integer }
 *               source_sample_id: { type: integer }
 *               notes:        { type: string }
 *               user_id:      { type: string }
 *               user_name:    { type: string }
 *     responses:
 *       201:
 *         description: Inventory item created
 *       500:
 *         description: Server error
 */
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const {
      brand, quantity, name, price, stockin, billing,
      units, width, height,
      project_id, project_name,
      source_dc_id, source_po_id, source_pr_id, source_sample_id,
      notes,
      user_id, user_name,
    } = req.body;

    const qty = Number(quantity) || 0;

    const result = await client.query(
      `INSERT INTO inventories
         (brand, quantity, current_quantity, name, price, stockin, billing,
          units, width, height, project_id, source_dc_id, source_po_id,
          source_pr_id, source_sample_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        brand, qty, qty, name, price,
        stockin ?? false, billing ?? false,
        units, width, height,
        project_id || null,
        source_dc_id || null, source_po_id || null,
        source_pr_id || null, source_sample_id || null,
      ]
    );

    const item = result.rows[0];

    // Log creation event into inventory_history
    await logInventoryHistory(client, {
      inventory_id:      item.inventory_id,
      item_name:         item.name,
      item_brand:        item.brand,
      item_units:        item.units,
      change_type:       "created",
      stock_in:          qty,
      stock_out:         0,
      balance_before:    0,
      balance_after:     qty,
      source_type:       source_dc_id ? "dc"
                       : source_po_id ? "po"
                       : source_pr_id ? "pr"
                       : source_sample_id ? "sample"
                       : "manual",
      source_id:         source_dc_id || source_po_id || source_pr_id || source_sample_id || null,
      project_id,
      project_name,
      notes:             notes || "New inventory item created",
      performed_by:      user_id,
      performed_by_name: user_name,
    });

    // If opening stock > 0, also record an inventory_movements row
    if (qty > 0) {
      await recordMovement(client, {
        inventory_id:      item.inventory_id,
        movement_type:     "in",
        quantity:          qty,
        source_type:       source_dc_id ? "dc"
                         : source_po_id ? "po"
                         : source_pr_id ? "pr"
                         : source_sample_id ? "sample"
                         : "manual",
        source_id:         source_dc_id || source_po_id || source_pr_id || source_sample_id || null,
        source_ref:        null,
        project_id,        project_name,
        notes:             notes || "Opening stock",
        performed_by:      user_id,
        performed_by_name: user_name,
      });
    }

    await client.query("COMMIT");
    res.status(201).json(item);

    logActivity({
      action: "created", entity_type: "inventory",
      entity_id: item.inventory_id, entity_name: item.name,
      performed_by: user_id || null, performed_by_name: user_name || null,
      meta: { brand, quantity: qty, price },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error creating inventory item:", err);
    res.status(500).json({ error: "Internal Server Error" });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inventory  – list all
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/inventory:
 *   get:
 *     summary: Get all inventory items
 *     tags: [Inventory]
 *     responses:
 *       200:
 *         description: List of inventory items
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM inventories ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching inventory:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inventory/search?q=
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/inventory/search:
 *   get:
 *     summary: Search inventory items by name or brand
 *     tags: [Inventory]
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Matching inventory items
 */
router.get("/search", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim() === "")
      return res.status(400).json({ error: "Query parameter 'q' is required" });

    const keyword = `%${q.trim()}%`;
    const result = await pool.query(
      `SELECT
         i.*,
         dc.challan_number   AS last_dc_challan,
         dc.challan_date     AS last_dc_date,
         COALESCE(mv.total_in,  0) AS total_in,
         COALESCE(mv.total_out, 0) AS total_out,
         mv.movement_count
       FROM inventories i
       LEFT JOIN delivery_challans dc ON dc.dc_id = i.source_dc_id
       LEFT JOIN LATERAL (
         SELECT
           SUM(CASE WHEN movement_type = 'in'  THEN quantity ELSE 0 END) AS total_in,
           SUM(CASE WHEN movement_type = 'out' THEN quantity ELSE 0 END) AS total_out,
           COUNT(*) AS movement_count
         FROM inventory_movements
         WHERE inventory_id = i.inventory_id
       ) mv ON TRUE
       WHERE i.name  ILIKE $1
          OR i.brand ILIKE $1
       ORDER BY i.updated_at DESC`,
      [keyword]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error searching inventory:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inventory/:id
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/inventory/{id}:
 *   get:
 *     summary: Get an inventory item by ID
 *     tags: [Inventory]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Inventory item details
 *       404:
 *         description: Not found
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "SELECT * FROM inventories WHERE inventory_id = $1",
      [id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Inventory item not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching inventory item:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inventory/:id/history  – movement history for one item (existing)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/inventory/{id}/history:
 *   get:
 *     summary: Get movement history for an inventory item
 *     tags: [Inventory]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: source_type
 *         schema: { type: string, enum: [dc, po, pr, sample, mir, manual] }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Movement history with item details
 *       404:
 *         description: Inventory item not found
 */
router.get("/:id/history", async (req, res) => {
  try {
    const { id } = req.params;
    const { source_type, from, to } = req.query;

    const itemRes = await pool.query(
      "SELECT * FROM inventories WHERE inventory_id = $1",
      [id]
    );
    if (itemRes.rows.length === 0)
      return res.status(404).json({ error: "Inventory item not found" });

    const conditions = ["m.inventory_id = $1"];
    const values     = [id];
    let   idx        = 2;

    if (source_type) { conditions.push(`m.source_type = $${idx++}`); values.push(source_type); }
    if (from)        { conditions.push(`m.created_at >= $${idx++}`); values.push(from); }
    if (to)          { conditions.push(`m.created_at <= $${idx++}`); values.push(to + " 23:59:59"); }

    const movRes = await pool.query(
      `SELECT
         m.*,
         dc.challan_number, dc.challan_date, dc.po_number AS dc_po_number,
         po.order_no AS po_order_no, po.vendor_name,
         pr.pr_number, pr.location AS pr_location,
         s.building_name AS sample_building
       FROM inventory_movements m
       LEFT JOIN delivery_challans dc ON m.source_type = 'dc'     AND dc.dc_id    = m.source_id
       LEFT JOIN pos              po  ON m.source_type = 'po'     AND po.po_id    = m.source_id
       LEFT JOIN prs              pr  ON m.source_type = 'pr'     AND pr.pr_id    = m.source_id
       LEFT JOIN samples          s   ON m.source_type = 'sample' AND s.sample_id = m.source_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY m.created_at DESC`,
      values
    );

    res.json({
      item: itemRes.rows[0],
      movements: movRes.rows,
      summary: {
        total_in:  movRes.rows.filter(r => r.movement_type === "in").reduce((a, r) => a + Number(r.quantity), 0),
        total_out: movRes.rows.filter(r => r.movement_type === "out").reduce((a, r) => a + Number(r.quantity), 0),
        count:     movRes.rows.length,
      },
    });
  } catch (err) {
    console.error("Error fetching inventory history:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inventory/:id/background
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/inventory/{id}/background:
 *   get:
 *     summary: Full background/provenance of an inventory item
 *     tags: [Inventory]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Full item background
 *       404:
 *         description: Not found
 */
router.get("/:id/background", async (req, res) => {
  try {
    const { id } = req.params;
    const itemRes = await pool.query(
      "SELECT * FROM inventories WHERE inventory_id = $1",
      [id]
    );
    if (itemRes.rows.length === 0)
      return res.status(404).json({ error: "Inventory item not found" });

    const item = itemRes.rows[0];

    const [dcRes, poRes, prRes, sampleRes, movRes] = await Promise.all([
      item.source_dc_id
        ? pool.query("SELECT * FROM delivery_challans WHERE dc_id = $1", [item.source_dc_id])
        : { rows: [] },
      item.source_po_id
        ? pool.query("SELECT * FROM pos WHERE po_id = $1", [item.source_po_id])
        : { rows: [] },
      item.source_pr_id
        ? pool.query("SELECT * FROM prs WHERE pr_id = $1", [item.source_pr_id])
        : { rows: [] },
      item.source_sample_id
        ? pool.query("SELECT * FROM samples WHERE sample_id = $1", [item.source_sample_id])
        : { rows: [] },
      pool.query(
        `SELECT m.*,
                dc.challan_number, dc.challan_date,
                po.order_no AS po_order_no, po.vendor_name,
                pr.pr_number,
                s.building_name AS sample_building
           FROM inventory_movements m
           LEFT JOIN delivery_challans dc ON m.source_type='dc'     AND dc.dc_id    =m.source_id
           LEFT JOIN pos              po  ON m.source_type='po'     AND po.po_id    =m.source_id
           LEFT JOIN prs              pr  ON m.source_type='pr'     AND pr.pr_id    =m.source_id
           LEFT JOIN samples          s   ON m.source_type='sample' AND s.sample_id =m.source_id
          WHERE m.inventory_id = $1
          ORDER BY m.created_at ASC`,
        [id]
      ),
    ]);

    const movements = movRes.rows;

    res.json({
      item,
      sources: {
        delivery_challan: dcRes.rows[0] || null,
        purchase_order:   poRes.rows[0] || null,
        purchase_request: prRes.rows[0] || null,
        sample:           sampleRes.rows[0] || null,
      },
      movements,
      summary: {
        total_in:        movements.filter(r => r.movement_type === "in").reduce((a, r) => a + Number(r.quantity), 0),
        total_out:       movements.filter(r => r.movement_type === "out").reduce((a, r) => a + Number(r.quantity), 0),
        current_balance: item.current_quantity,
        movement_count:  movements.length,
      },
    });
  } catch (err) {
    console.error("Error fetching item background:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inventory/:id/movement  – manual stock-in / stock-out / adjustment
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/inventory/{id}/movement:
 *   post:
 *     summary: Record a manual stock movement (in / out / adjustment)
 *     tags: [Inventory]
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
 *             required: [movement_type, quantity]
 *             properties:
 *               movement_type: { type: string, enum: [in, out, adjustment] }
 *               quantity:      { type: number }
 *               source_type:   { type: string, enum: [dc, po, pr, sample, mir, manual] }
 *               source_id:     { type: integer }
 *               source_ref:    { type: string }
 *               project_id:    { type: integer }
 *               project_name:  { type: string }
 *               notes:         { type: string }
 *               user_id:       { type: string }
 *               user_name:     { type: string }
 *     responses:
 *       200:
 *         description: Movement recorded
 *       400:
 *         description: Bad request
 *       404:
 *         description: Inventory item not found
 */
router.post("/:id/movement", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const {
      movement_type, quantity,
      source_type, source_id, source_ref,
      project_id, project_name, notes,
      user_id, user_name,
    } = req.body;

    if (!movement_type || !quantity)
      return res.status(400).json({ error: "movement_type and quantity are required" });
    if (!["in", "out", "adjustment"].includes(movement_type))
      return res.status(400).json({ error: "movement_type must be in | out | adjustment" });

    const itemRes = await pool.query(
      "SELECT * FROM inventories WHERE inventory_id = $1",
      [id]
    );
    if (itemRes.rows.length === 0)
      return res.status(404).json({ error: "Inventory item not found" });

    await client.query("BEGIN");

    const balance = await recordMovement(client, {
      inventory_id:      id,
      movement_type,
      quantity:          Number(quantity),
      source_type:       source_type || "manual",
      source_id, source_ref,
      project_id, project_name, notes,
      performed_by:      user_id,
      performed_by_name: user_name,
    });

    await client.query("COMMIT");

    res.json({ message: "Movement recorded", new_balance: balance });

    logActivity({
      action:              movement_type === "in" ? "stock_in" : movement_type === "out" ? "stock_out" : "adjustment",
      entity_type:         "inventory",
      entity_id:           id,
      entity_name:         itemRes.rows[0].name,
      performed_by:        user_id || null,
      performed_by_name:   user_name || null,
      meta:                { quantity, source_type, source_ref },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error recording movement:", err);
    res.status(500).json({ error: "Internal Server Error" });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/inventory/:id  – update metadata
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/inventory/{id}:
 *   put:
 *     summary: Update an inventory item (metadata only — use /movement for qty)
 *     tags: [Inventory]
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
    const { id } = req.params;
    const { brand, name, price, stockin, billing, units, width, height, user_id, user_name } = req.body;

    // Snapshot old values for change diff
    const oldRes = await client.query(
      "SELECT * FROM inventories WHERE inventory_id = $1",
      [id]
    );
    if (oldRes.rows.length === 0)
      return res.status(404).json({ error: "Inventory item not found" });

    const old = oldRes.rows[0];

    await client.query("BEGIN");

    const result = await client.query(
      `UPDATE inventories SET
         brand      = COALESCE($1, brand),
         name       = COALESCE($2, name),
         price      = COALESCE($3, price),
         stockin    = COALESCE($4, stockin),
         billing    = COALESCE($5, billing),
         units      = COALESCE($6, units),
         width      = COALESCE($7, width),
         height     = COALESCE($8, height),
         updated_at = CURRENT_TIMESTAMP
       WHERE inventory_id = $9
       RETURNING *`,
      [brand, name, price, stockin, billing, units, width, height, id]
    );

    const updated = result.rows[0];

    // Build a diff of what changed for the history log
    const changed_fields = {};
    const fields = ["brand", "name", "price", "stockin", "billing", "units", "width", "height"];
    fields.forEach(f => {
      if (req.body[f] !== undefined && req.body[f] !== old[f]) {
        changed_fields[f] = { from: old[f], to: req.body[f] };
      }
    });

    // Log to inventory_history
    await logInventoryHistory(client, {
      inventory_id:      id,
      item_name:         updated.name,
      item_brand:        updated.brand,
      item_units:        updated.units,
      change_type:       "updated",
      stock_in:          0,
      stock_out:         0,
      balance_before:    Number(updated.current_quantity) || 0,
      balance_after:     Number(updated.current_quantity) || 0,
      source_type:       "manual",
      notes:             "Metadata updated",
      performed_by:      user_id  || null,
      performed_by_name: user_name || null,
      changed_fields:    Object.keys(changed_fields).length ? changed_fields : null,
    });

    await client.query("COMMIT");
    res.json(updated);

    logActivity({
      action: "updated", entity_type: "inventory",
      entity_id: id, entity_name: updated.name,
      performed_by:      user_id || null,
      performed_by_name: user_name || null,
      meta: { updates: req.body },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error updating inventory item:", err);
    res.status(500).json({ error: "Internal Server Error" });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/inventory/:id/stockin
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/:id/stockin", async (req, res) => {
  try {
    const { id }      = req.params;
    const { stockin } = req.body;

    if (typeof stockin !== "boolean")
      return res.status(400).json({ error: "stockin must be a boolean" });

    const result = await pool.query(
      "UPDATE inventories SET stockin=$1, updated_at=CURRENT_TIMESTAMP WHERE inventory_id=$2 RETURNING *",
      [stockin, id]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "Inventory item not found" });

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error updating stockin:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/inventory/:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id }                      = req.params;
    const { user_id, user_name } = req.body || {};

    const existing = await client.query(
      "SELECT * FROM inventories WHERE inventory_id = $1",
      [id]
    );
    if (existing.rows.length === 0)
      return res.status(404).json({ error: "Inventory item not found" });

    const item = existing.rows[0];

    await client.query("BEGIN");

    // Log deletion BEFORE the row is removed (CASCADE will wipe history entries)
    await logInventoryHistory(client, {
      inventory_id:      id,
      item_name:         item.name,
      item_brand:        item.brand,
      item_units:        item.units,
      change_type:       "deleted",
      stock_in:          0,
      stock_out:         Number(item.current_quantity) || 0,
      balance_before:    Number(item.current_quantity) || 0,
      balance_after:     0,
      source_type:       "manual",
      notes:             "Inventory item deleted",
      performed_by:      user_id  || null,
      performed_by_name: user_name || null,
    });

    await client.query("DELETE FROM inventories WHERE inventory_id = $1", [id]);

    await client.query("COMMIT");

    res.json({ message: "Inventory item deleted successfully" });

    logActivity({
      action: "deleted", entity_type: "inventory",
      entity_id: id, entity_name: item.name,
      performed_by:      user_id  || null,
      performed_by_name: user_name || null,
      meta: {},
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error deleting inventory item:", err);
    res.status(500).json({ error: "Internal Server Error" });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────
module.exports        = router;
module.exports.recordMovement = recordMovement;