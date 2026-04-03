const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { logActivity } = require("./dashboard");
const { logInventoryHistory } = require("./inventory_history");

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

  // Insert into inventory_movements
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

  // Also log into inventory_history
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
// HELPER: resolve human-readable source name for a history/movement row
// ─────────────────────────────────────────────────────────────────────────────
async function resolveSourceName(sourceType, sourceId) {
  if (!sourceType || !sourceId) return null;
  try {
    switch (sourceType) {
      case "dc": {
        const r = await pool.query(
          "SELECT challan_number, challan_date FROM delivery_challans WHERE dc_id = $1",
          [sourceId]
        );
        return r.rows[0]
          ? { label: `DC: ${r.rows[0].challan_number}`, ...r.rows[0] }
          : null;
      }
      case "po": {
        const r = await pool.query(
          "SELECT order_no, vendor_name FROM pos WHERE po_id = $1",
          [sourceId]
        );
        return r.rows[0]
          ? { label: `PO: ${r.rows[0].order_no}${r.rows[0].vendor_name ? ` (${r.rows[0].vendor_name})` : ""}`, ...r.rows[0] }
          : null;
      }
      case "pr": {
        const r = await pool.query(
          "SELECT pr_id, location FROM purchase_requisitions WHERE pr_id = $1",
          [sourceId]
        );
        return r.rows[0]
          ? { label: `PR: ${r.rows[0].pr_id || `#${sourceId}`}`, ...r.rows[0] }
          : null;
      }
      case "sample": {
        const r = await pool.query(
          "SELECT building_name, site_name FROM samples WHERE sample_id = $1",
          [sourceId]
        );
        return r.rows[0]
          ? { label: `Sample: ${r.rows[0].building_name || r.rows[0].site_name || `#${sourceId}`}`, ...r.rows[0] }
          : null;
      }
      case "mir": {
        const r = await pool.query(
          "SELECT mir_refrence_no FROM mirs WHERE mir_id = $1",
          [sourceId]
        );
        return r.rows[0]
          ? { label: `MIR: ${r.rows[0].mir_refrence_no || `#${sourceId}`}`, ...r.rows[0] }
          : null;
      }
      default:
        return { label: "Manual Entry" };
    }
  } catch {
    return null;
  }
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
// Basic search — returns matching items with movement totals
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
         po.order_no         AS po_order_no,
         po.vendor_name      AS po_vendor_name,
         s.building_name     AS sample_building,
         COALESCE(mv.total_in,  0) AS total_in,
         COALESCE(mv.total_out, 0) AS total_out,
         mv.movement_count
       FROM inventories i
       LEFT JOIN delivery_challans dc ON dc.dc_id    = i.source_dc_id
       LEFT JOIN pos               po ON po.po_id    = i.source_po_id
       LEFT JOIN samples           s  ON s.sample_id = i.source_sample_id
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
// GET /api/inventory/search-with-history?q=ITEM_NAME
//
// ★ THE KEY NEW ENDPOINT ★
//
// User searches for an item by name/brand.
// Response includes:
//   - All matching inventory items (with current stock)
//   - For EACH item: full history with resolved source names
//     (DC challan number, PO order no, PR number, Sample building, MIR ref)
//   - Summary: total in, total out, current balance
//
// Query params:
//   q           (required) — search term
//   project_id  (optional) — filter to a specific project
//   from        (optional) — history date range start (YYYY-MM-DD)
//   to          (optional) — history date range end   (YYYY-MM-DD)
//   limit       (optional) — max history rows per item (default 50)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/inventory/search-with-history:
 *   get:
 *     summary: Search inventory by name and return full movement history
 *     tags: [Inventory]
 *     description: |
 *       One-call endpoint for the "find an item and see everything that happened to it" flow.
 *       Returns all matching items plus their complete movement history with resolved
 *       source document names (DC challan number, PO order, PR number, Sample building, MIR ref).
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *         description: Search term (matches name or brand, case-insensitive)
 *       - in: query
 *         name: project_id
 *         schema: { type: integer }
 *         description: Filter to a specific project
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *         description: History from date (e.g. 2024-01-01)
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *         description: History to date (e.g. 2024-12-31)
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *         description: Max history rows per item
 *     responses:
 *       200:
 *         description: |
 *           { count, items: [ { ...item, history: [...], summary: {...} } ] }
 *       400:
 *         description: Missing q param
 *       500:
 *         description: Server error
 */
router.get("/search-with-history", async (req, res) => {
  try {
    const { q, project_id, from, to, limit = 50 } = req.query;
    if (!q || !q.trim())
      return res.status(400).json({ error: "Query parameter 'q' is required" });

    const keyword  = `%${q.trim()}%`;
    const limitNum = Math.min(200, Math.max(1, parseInt(limit) || 50));

    // ── Step 1: find matching inventory items ─────────────────────────────
    const itemQuery = project_id
      ? `SELECT i.*,
               dc.challan_number   AS source_dc_challan,
               dc.challan_date     AS source_dc_date,
               po.order_no         AS source_po_order_no,
               po.vendor_name      AS source_po_vendor,
               pr.pr_number        AS source_pr_number,
               s.building_name     AS source_sample_building,
               s.site_name         AS source_sample_site
             FROM inventories i
             LEFT JOIN delivery_challans dc ON dc.dc_id    = i.source_dc_id
             LEFT JOIN pos               po ON po.po_id    = i.source_po_id
             LEFT JOIN purchase_requisitions pr ON pr.pr_id    = i.source_pr_id
             LEFT JOIN samples           s  ON s.sample_id = i.source_sample_id
            WHERE (i.name ILIKE $1 OR i.brand ILIKE $1)
              AND (i.project_id = $2 OR i.project_id IS NULL)
            ORDER BY CASE WHEN i.project_id = $2 THEN 0 ELSE 1 END, i.updated_at DESC`
      : `SELECT i.*,
               dc.challan_number   AS source_dc_challan,
               dc.challan_date     AS source_dc_date,
               po.order_no         AS source_po_order_no,
               po.vendor_name      AS source_po_vendor,
               pr.pr_number        AS source_pr_number,
               s.building_name     AS source_sample_building,
               s.site_name         AS source_sample_site
             FROM inventories i
             LEFT JOIN delivery_challans dc ON dc.dc_id    = i.source_dc_id
             LEFT JOIN pos               po ON po.po_id    = i.source_po_id
             LEFT JOIN purchase_requisitions pr ON pr.pr_id    = i.source_pr_id
             LEFT JOIN samples           s  ON s.sample_id = i.source_sample_id
            WHERE (i.name ILIKE $1 OR i.brand ILIKE $1)
            ORDER BY i.updated_at DESC`;

    const itemParams = project_id ? [keyword, Number(project_id)] : [keyword];
    const itemsRes   = await pool.query(itemQuery, itemParams);

    if (itemsRes.rows.length === 0) {
      return res.json({ count: 0, items: [], search_term: q.trim() });
    }

    // ── Step 2: for each item load full history with resolved source names ─
    const itemsWithHistory = await Promise.all(
      itemsRes.rows.map(async (item) => {
        // Build history WHERE clause
        const histConditions = ["h.inventory_id = $1"];
        const histValues     = [item.inventory_id];
        let   histIdx        = 2;

        if (from) { histConditions.push(`h.created_at >= $${histIdx++}`); histValues.push(from); }
        if (to)   { histConditions.push(`h.created_at <= $${histIdx++}`); histValues.push(to + " 23:59:59"); }

        const histWhere = histConditions.join(" AND ");

        // Fetch history rows with full source document joins
        const histRes = await pool.query(
          `SELECT
             h.history_id,
             h.change_type,
             CASE h.change_type
               WHEN 'stock_in'   THEN 'Stock In'
               WHEN 'stock_out'  THEN 'Stock Out'
               WHEN 'adjustment' THEN 'Adjustment'
               WHEN 'created'    THEN 'Item Created'
               WHEN 'updated'    THEN 'Item Updated'
               WHEN 'deleted'    THEN 'Item Deleted'
               ELSE h.change_type
             END AS change_type_label,
             h.stock_in,
             h.stock_out,
             h.balance_before,
             h.balance_after,
             (h.balance_after - h.balance_before) AS net_change,
             h.source_type,
             CASE h.source_type
               WHEN 'dc'     THEN 'Delivery Challan'
               WHEN 'po'     THEN 'Purchase Order'
               WHEN 'pr'     THEN 'Purchase Request'
               WHEN 'sample' THEN 'Sample'
               WHEN 'mir'    THEN 'MIR'
               WHEN 'manual' THEN 'Manual Entry'
               ELSE COALESCE(h.source_type, 'Unknown')
             END AS source_type_label,
             h.source_id,
             h.source_ref,

             -- ── Resolved source document details ──────────────
             dc.challan_number     AS dc_challan_number,
             dc.challan_date       AS dc_challan_date,
             dc.po_number          AS dc_po_number,

             po.order_no           AS po_order_no,
             po.vendor_name        AS po_vendor_name,
             po.po_date            AS po_date,

             pr.pr_number          AS pr_number,
             pr.location           AS pr_location,
             pr.project_name       AS pr_project_name,

             -- PR item-level detail: which material was issued
             (SELECT pri2.material_description
                FROM purchase_requisition_items pri2
               WHERE pri2.pr_id = h.source_id
                 AND pri2.inventory_id = h.inventory_id
               LIMIT 1)           AS pr_item_material,

             s.building_name       AS sample_building,
             s.site_name           AS sample_site,
             s.work_done           AS sample_work_done,

             mir.mir_refrence_no   AS mir_ref_no,

             -- ── Who / when ────────────────────────────────────
             h.project_id,
             h.project_name,
             h.notes,
             h.performed_by,
             h.performed_by_name,
             h.changed_fields,
             h.created_at,

             -- ── Human-readable event label ────────────────────
             CASE
               WHEN h.source_type = 'dc'     THEN 'Received via DC: ' || COALESCE(dc.challan_number, '#' || h.source_id::text)
               WHEN h.source_type = 'po'     THEN 'From PO: '         || COALESCE(po.order_no,       '#' || h.source_id::text)
               WHEN h.source_type = 'pr'     THEN 'Issued to PR: '    || COALESCE(pr.pr_number,      '#' || h.source_id::text)
               WHEN h.source_type = 'sample' THEN 'Used in Sample: '  || COALESCE(s.building_name,   '#' || h.source_id::text)
               WHEN h.source_type = 'mir'    THEN 'MIR: '             || COALESCE(mir.mir_refrence_no,'#' || h.source_id::text)
               WHEN h.change_type = 'created'THEN 'Item created'
               WHEN h.change_type = 'updated'THEN 'Metadata updated'
               ELSE COALESCE(h.source_ref, 'Manual entry')
             END AS event_label

           FROM inventory_history h
           LEFT JOIN delivery_challans dc
                  ON h.source_type = 'dc'     AND dc.dc_id      = h.source_id
           LEFT JOIN pos po
                  ON h.source_type = 'po'     AND po.po_id       = h.source_id
           LEFT JOIN prs pr
                  ON h.source_type = 'pr'     AND pr.pr_id       = h.source_id
           LEFT JOIN samples s
                  ON h.source_type = 'sample' AND s.sample_id    = h.source_id
           LEFT JOIN mirs mir
                  ON h.source_type = 'mir'    AND mir.mir_id     = h.source_id
           WHERE ${histWhere}
           ORDER BY h.created_at DESC
           LIMIT $${histIdx}`,
          [...histValues, limitNum]
        );

        // ── Summary for this item ────────────────────────────────────────
        const summaryRes = await pool.query(
          `SELECT
             COALESCE(SUM(stock_in),  0) AS total_stock_in,
             COALESCE(SUM(stock_out), 0) AS total_stock_out,
             COUNT(*)                    AS total_events,
             MIN(created_at)             AS first_event_at,
             MAX(created_at)             AS last_event_at
           FROM inventory_history
           WHERE inventory_id = $1`,
          [item.inventory_id]
        );

        return {
          // Item core details
          inventory_id:    item.inventory_id,
          name:            item.name,
          brand:           item.brand,
          units:           item.units,
          price:           item.price,
          current_balance: item.current_quantity,
          project_id:      item.project_id,

          // Where this item originally came from
          origin: {
            dc:     item.source_dc_id     ? { dc_id:     item.source_dc_id,     challan_number: item.source_dc_challan,   challan_date:    item.source_dc_date   } : null,
            po:     item.source_po_id     ? { po_id:     item.source_po_id,     order_no:       item.source_po_order_no,  vendor_name:     item.source_po_vendor } : null,
            pr:     item.source_pr_id     ? { pr_id:     item.source_pr_id,     pr_number:      item.source_pr_number                                            } : null,
            sample: item.source_sample_id ? { sample_id: item.source_sample_id, building_name:  item.source_sample_building, site_name: item.source_sample_site  } : null,
          },

          // Aggregated summary
          summary: {
            total_stock_in:  Number(summaryRes.rows[0]?.total_stock_in  || 0),
            total_stock_out: Number(summaryRes.rows[0]?.total_stock_out || 0),
            current_balance: Number(item.current_quantity || 0),
            total_events:    Number(summaryRes.rows[0]?.total_events    || 0),
            first_event_at:  summaryRes.rows[0]?.first_event_at || null,
            last_event_at:   summaryRes.rows[0]?.last_event_at  || null,
          },

          // Full history list
          history: histRes.rows,
        };
      })
    );

    res.json({
      search_term: q.trim(),
      count:       itemsWithHistory.length,
      filters: {
        project_id: project_id || null,
        from:       from || null,
        to:         to   || null,
      },
      items: itemsWithHistory,
    });
  } catch (err) {
    console.error("Error in search-with-history:", err);
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
      `SELECT i.*,
              dc.challan_number   AS source_dc_challan,
              dc.challan_date     AS source_dc_date,
              po.order_no         AS source_po_order_no,
              po.vendor_name      AS source_po_vendor,
              pr.pr_number        AS source_pr_number,
              s.building_name     AS source_sample_building
         FROM inventories i
         LEFT JOIN delivery_challans dc ON dc.dc_id    = i.source_dc_id
         LEFT JOIN pos               po ON po.po_id    = i.source_po_id
         LEFT JOIN purchase_requisitions pr ON pr.pr_id    = i.source_pr_id
         LEFT JOIN samples           s  ON s.sample_id = i.source_sample_id
        WHERE i.inventory_id = $1`,
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
// GET /api/inventory/:id/history
// Movement history for one item — with resolved source document names
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/inventory/{id}/history:
 *   get:
 *     summary: Get movement history for an inventory item (with source names resolved)
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
 *         description: Movement history with item details and resolved source names
 *       404:
 *         description: Inventory item not found
 */
router.get("/:id/history", async (req, res) => {
  try {
    const { id } = req.params;
    const { source_type, from, to } = req.query;

    const itemRes = await pool.query(
      `SELECT i.*,
              dc.challan_number   AS source_dc_challan,
              po.order_no         AS source_po_order_no,
              po.vendor_name      AS source_po_vendor,
              pr.pr_number        AS source_pr_number,
              s.building_name     AS source_sample_building
         FROM inventories i
         LEFT JOIN delivery_challans dc ON dc.dc_id    = i.source_dc_id
         LEFT JOIN pos               po ON po.po_id    = i.source_po_id
         LEFT JOIN prs               pr ON pr.pr_id    = i.source_pr_id
         LEFT JOIN samples           s  ON s.sample_id = i.source_sample_id
        WHERE i.inventory_id = $1`,
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
         -- DC
         dc.challan_number     AS dc_challan_number,
         dc.challan_date       AS dc_challan_date,
         dc.po_number          AS dc_po_number,
         -- PO
         po.order_no           AS po_order_no,
         po.vendor_name        AS po_vendor_name,
         -- PR
         pr.pr_number          AS pr_number,
         pr.location           AS pr_location,
         pr.project_name       AS pr_project_name,
         -- PR item material name (what was issued)
         (SELECT pri.material_description
            FROM purchase_requisition_items pri
           WHERE pri.pr_id = m.source_id
             AND pri.inventory_id = m.inventory_id
           LIMIT 1)            AS pr_item_material,
         -- Sample
         s.building_name       AS sample_building,
         s.site_name           AS sample_site,
         -- MIR
         mir.mir_refrence_no   AS mir_ref_no,
         -- Computed event label
         CASE
           WHEN m.source_type = 'dc'     THEN 'Received via DC: '  || COALESCE(dc.challan_number, '#' || m.source_id::text)
           WHEN m.source_type = 'po'     THEN 'From PO: '           || COALESCE(po.order_no,       '#' || m.source_id::text)
           WHEN m.source_type = 'pr'     THEN 'Issued to PR: '      || COALESCE(pr.pr_number,      '#' || m.source_id::text)
           WHEN m.source_type = 'sample' THEN 'Used in Sample: '    || COALESCE(s.building_name,   '#' || m.source_id::text)
           WHEN m.source_type = 'mir'    THEN 'MIR: '               || COALESCE(mir.mir_refrence_no,'#'|| m.source_id::text)
           ELSE COALESCE(m.source_ref, 'Manual entry')
         END AS event_label
       FROM inventory_movements m
       LEFT JOIN delivery_challans dc  ON m.source_type = 'dc'     AND dc.dc_id      = m.source_id
       LEFT JOIN pos               po  ON m.source_type = 'po'     AND po.po_id       = m.source_id
       LEFT JOIN prs               pr  ON m.source_type = 'pr'     AND pr.pr_id       = m.source_id
       LEFT JOIN samples           s   ON m.source_type = 'sample' AND s.sample_id    = m.source_id
       LEFT JOIN mirs              mir ON m.source_type = 'mir'    AND mir.mir_id     = m.source_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY m.created_at DESC`,
      values
    );

    res.json({
      item:      itemRes.rows[0],
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
// Full provenance — upstream chain + all movements
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
        ? pool.query("SELECT * FROM purchase_requisitions WHERE pr_id = $1", [item.source_pr_id])
        : { rows: [] },
      item.source_sample_id
        ? pool.query("SELECT * FROM samples WHERE sample_id = $1", [item.source_sample_id])
        : { rows: [] },
      pool.query(
        `SELECT m.*,
                dc.challan_number, dc.challan_date,
                po.order_no AS po_order_no, po.vendor_name,
                pr.pr_id AS pr_number,
                (SELECT pri.material_description FROM purchase_requisition_items pri
                  WHERE pri.pr_id = m.source_id AND pri.inventory_id = m.inventory_id LIMIT 1) AS pr_item_material,
                s.building_name AS sample_building,
                mir.mir_refrence_no AS mir_ref_no,
                CASE
                  WHEN m.source_type = 'dc'     THEN 'Received via DC: '  || COALESCE(dc.challan_number, '#' || m.source_id::text)
                  WHEN m.source_type = 'po'     THEN 'From PO: '           || COALESCE(po.order_no,       '#' || m.source_id::text)
                  WHEN m.source_type = 'pr'     THEN 'Issued to PR: '      || COALESCE(pr.pr_number,      '#' || m.source_id::text)
                  WHEN m.source_type = 'sample' THEN 'Used in Sample: '    || COALESCE(s.building_name,   '#' || m.source_id::text)
                  WHEN m.source_type = 'mir'    THEN 'MIR: '               || COALESCE(mir.mir_refrence_no,'#'|| m.source_id::text)
                  ELSE COALESCE(m.source_ref, 'Manual entry')
                END AS event_label
           FROM inventory_movements m
           LEFT JOIN delivery_challans dc  ON m.source_type='dc'     AND dc.dc_id    =m.source_id
           LEFT JOIN pos               po  ON m.source_type='po'     AND po.po_id    =m.source_id
           LEFT JOIN purchase_requisitions pr  ON m.source_type='pr'     AND pr.pr_id    =m.source_id
           LEFT JOIN samples           s   ON m.source_type='sample' AND s.sample_id =m.source_id
           LEFT JOIN mirs              mir ON m.source_type='mir'    AND mir.mir_id  =m.source_id
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

    const changed_fields = {};
    const fields = ["brand", "name", "price", "stockin", "billing", "units", "width", "height"];
    fields.forEach(f => {
      if (req.body[f] !== undefined && req.body[f] !== old[f]) {
        changed_fields[f] = { from: old[f], to: req.body[f] };
      }
    });

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
    const { id }             = req.params;
    const { user_id, user_name } = req.body || {};

    const existing = await client.query(
      "SELECT * FROM inventories WHERE inventory_id = $1",
      [id]
    );
    if (existing.rows.length === 0)
      return res.status(404).json({ error: "Inventory item not found" });

    const item = existing.rows[0];

    await client.query("BEGIN");

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