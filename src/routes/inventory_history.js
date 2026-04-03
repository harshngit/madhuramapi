const express = require("express");
const router  = express.Router();
const { pool } = require("../db");

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Log a change directly into inventory_history
// Used internally by inventory.js, delivery_challan.js, etc.
// ─────────────────────────────────────────────────────────────────────────────
async function logInventoryHistory(client, {
  inventory_id,
  item_name,
  item_brand,
  item_units,
  change_type,        // 'stock_in' | 'stock_out' | 'adjustment' | 'created' | 'updated'
  stock_in  = 0,
  stock_out = 0,
  balance_before = 0,
  balance_after  = 0,
  source_type,
  source_id,
  source_ref,
  project_id,
  project_name,
  notes,
  performed_by,
  performed_by_name,
  changed_fields = null,
}) {
  await client.query(
    `INSERT INTO inventory_history (
       inventory_id,
       item_name, item_brand, item_units,
       change_type,
       stock_in, stock_out,
       balance_before, balance_after,
       source_type, source_id, source_ref,
       project_id, project_name,
       notes,
       performed_by, performed_by_name,
       changed_fields
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       $10, $11, $12, $13, $14, $15, $16, $17, $18
     )`,
    [
      inventory_id,
      item_name   || null,
      item_brand  || null,
      item_units  || null,
      change_type,
      Number(stock_in)  || 0,
      Number(stock_out) || 0,
      Number(balance_before) || 0,
      Number(balance_after)  || 0,
      source_type || null,
      source_id   || null,
      source_ref  || null,
      project_id  || null,
      project_name || null,
      notes        || null,
      performed_by       || null,
      performed_by_name  || null,
      changed_fields ? JSON.stringify(changed_fields) : null,
    ]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED SQL: resolve a human-readable label from source_type + source_id
// This sub-select is inlined in the big history queries below so every row
// gets a "where did this movement come from?" display label.
// ─────────────────────────────────────────────────────────────────────────────
const SOURCE_LABEL_SQL = `
  CASE h.source_type
    WHEN 'dc'     THEN COALESCE(dc_src.challan_number,              CONCAT('DC #',     h.source_id))
    WHEN 'po'     THEN COALESCE(po_src.order_no,                    CONCAT('PO #',     h.source_id))
    WHEN 'pr'     THEN COALESCE(pr_src.project_name,                CONCAT('PR #',     h.source_id))
    WHEN 'sample' THEN COALESCE(sm_src.building_name,               CONCAT('Sample #', h.source_id))
    WHEN 'mir'    THEN COALESCE(mir_src.mir_refrence_no,            CONCAT('MIR #',    h.source_id))
    WHEN 'manual' THEN 'Manual Entry'
    ELSE COALESCE(h.source_ref, h.source_type, 'Unknown')
  END AS source_label
`;

// The LEFT JOINs needed to populate SOURCE_LABEL_SQL
const SOURCE_JOINS = `
  LEFT JOIN delivery_challans     dc_src  ON h.source_type = 'dc'     AND dc_src.dc_id       = h.source_id
  LEFT JOIN pos                   po_src  ON h.source_type = 'po'     AND po_src.po_id        = h.source_id
  LEFT JOIN purchase_requisitions pr_src  ON h.source_type = 'pr'     AND pr_src.pr_id        = h.source_id
  LEFT JOIN samples               sm_src  ON h.source_type = 'sample' AND sm_src.sample_id    = h.source_id
  LEFT JOIN mirs                  mir_src ON h.source_type = 'mir'    AND mir_src.mir_id      = h.source_id
`;

// Extra rich detail columns joined per source document
const SOURCE_DETAIL_SQL = `
  -- DC details
  dc_src.challan_number   AS dc_challan_number,
  dc_src.challan_date     AS dc_challan_date,

  -- PO details
  po_src.order_no         AS po_order_no,
  po_src.vendor_name      AS po_vendor_name,
  po_src.po_date          AS po_date,

  -- PR details
  pr_src.pr_id            AS pr_id,
  pr_src.project_name     AS pr_project_name,
  pr_src.workorder_no     AS pr_workorder_no,
  pr_src.location         AS pr_location,

  -- Sample details
  sm_src.sample_id        AS sample_id,
  sm_src.building_name    AS sample_building_name,
  sm_src.site_name        AS sample_site_name,
  sm_src.work_done        AS sample_work_done,

  -- MIR details
  mir_src.mir_refrence_no AS mir_reference_no
`;

// ─────────────────────────────────────────────────────────────────────────────
// ★ NEW  GET /api/inventory-history/search
//
// Search inventory items by name / brand and return each result with:
//   - current stock balance
//   - total in / out totals
//   - last movement date
//   - source chain (DC → PO → Sample)
//
// This is the "user types item name" endpoint.  After the user picks a result
// they call GET /api/inventory-history/item/:inventory_id for the full log.
//
// Query params:
//   q           (required) – search term
//   project_id  (optional) – bias results to a project
//   min_qty     (optional) – only items with current_quantity >= this
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/inventory-history/search:
 *   get:
 *     summary: Search inventory items and return a stock + history summary per result
 *     tags: [Inventory History]
 *     description: |
 *       Type-ahead search for inventory items. Every matching item is returned
 *       with its current balance, total in/out, last movement date, and the
 *       full source chain label (DC ← PO ← Sample).
 *       After selecting an item the frontend should call
 *       GET /api/inventory-history/item/:inventory_id for the detailed log.
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *         description: Search term (matches name or brand)
 *       - in: query
 *         name: project_id
 *         schema: { type: integer }
 *         description: Prefer items belonging to this project
 *       - in: query
 *         name: min_qty
 *         schema: { type: number }
 *         description: Only return items with at least this much stock (default 0 = all)
 *     responses:
 *       200:
 *         description: Matching inventory items with stock summary
 *       400:
 *         description: Missing query param q
 *       500:
 *         description: Server error
 */
router.get("/search", async (req, res) => {
  try {
    const { q, project_id, min_qty = 0 } = req.query;
    if (!q || !q.trim())
      return res.status(400).json({ error: "Query param 'q' is required" });

    const result = await pool.query(
      `SELECT
         i.inventory_id,
         i.name,
         i.brand,
         i.units,
         i.price,
         i.current_quantity                                    AS available_qty,
         i.project_id,
         i.created_at,
         i.updated_at,

         -- Source chain traceability
         dc.challan_number                                     AS source_dc_challan,
         dc.challan_date                                       AS source_dc_date,
         po.order_no                                           AS source_po_number,
         po.vendor_name                                        AS source_po_vendor,
         s.building_name                                       AS source_sample_building,
         s.site_name                                           AS source_sample_site,

         -- Movement totals (aggregated)
         COALESCE(mv.total_in,   0)                            AS total_stock_in,
         COALESCE(mv.total_out,  0)                            AS total_stock_out,
         COALESCE(mv.move_count, 0)                            AS movement_count,
         mv.last_movement_at,
         mv.last_movement_type,

         -- Project-match flag for ordering
         CASE WHEN i.project_id = $3 THEN true ELSE false END  AS same_project

       FROM inventories i
       LEFT JOIN delivery_challans dc ON dc.dc_id    = i.source_dc_id
       LEFT JOIN pos               po ON po.po_id    = i.source_po_id
       LEFT JOIN samples           s  ON s.sample_id = i.source_sample_id

       -- Aggregate all movements in one lateral subquery (single pass, fast)
       LEFT JOIN LATERAL (
         SELECT
           SUM(CASE WHEN movement_type = 'in'  THEN quantity ELSE 0 END) AS total_in,
           SUM(CASE WHEN movement_type = 'out' THEN quantity ELSE 0 END) AS total_out,
           COUNT(*)                                                        AS move_count,
           MAX(created_at)                                                AS last_movement_at,
           (ARRAY_AGG(movement_type ORDER BY created_at DESC))[1]        AS last_movement_type
         FROM inventory_movements
         WHERE inventory_id = i.inventory_id
       ) mv ON TRUE

       WHERE (i.name ILIKE $1 OR i.brand ILIKE $1)
         AND i.current_quantity >= $2

       ORDER BY
         CASE WHEN i.project_id = $3 THEN 0 ELSE 1 END,
         i.current_quantity DESC,
         i.updated_at DESC
       LIMIT 30`,
      [`%${q.trim()}%`, Number(min_qty) || 0, project_id ? Number(project_id) : null]
    );

    const items = result.rows.map(r => {
      // Build a readable chain label: DC ← PO ← Sample
      const parts = [];
      if (r.source_dc_challan)       parts.push(`DC: ${r.source_dc_challan}`);
      if (r.source_po_number)        parts.push(`PO: ${r.source_po_number}${r.source_po_vendor ? ` (${r.source_po_vendor})` : ""}`);
      if (r.source_sample_building)  parts.push(`Sample: ${r.source_sample_building}${r.source_sample_site ? ` – ${r.source_sample_site}` : ""}`);

      return {
        inventory_id:      r.inventory_id,
        name:              r.name,
        brand:             r.brand,
        units:             r.units,
        price:             r.price,
        available_qty:     r.available_qty,
        same_project:      r.same_project,
        source_chain:      parts.join(" ← ") || "Manual / Direct Entry",
        source_dc_challan: r.source_dc_challan,
        source_po_number:  r.source_po_number,
        source_po_vendor:  r.source_po_vendor,
        source_building:   r.source_sample_building,
        totals: {
          stock_in:       r.total_stock_in,
          stock_out:      r.total_stock_out,
          movement_count: r.movement_count,
          last_movement_at:   r.last_movement_at,
          last_movement_type: r.last_movement_type,
        },
      };
    });

    res.json({ count: items.length, items });
  } catch (err) {
    console.error("Inventory history search error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inventory-history
// Global inventory history — all items, all users
//
// Query params:
//   inventory_id  → filter by specific item
//   user_id       → filter by who made the change (performed_by UUID)
//   change_type   → stock_in | stock_out | adjustment | created | updated
//   source_type   → dc | po | pr | sample | mir | manual
//   project_id    → filter by project
//   from          → ISO date string  (e.g. 2024-01-01)
//   to            → ISO date string  (e.g. 2024-12-31)
//   page          → page number (default 1)
//   limit         → rows per page (default 20, max 100)
//   sort          → asc | desc (default desc)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/inventory-history:
 *   get:
 *     summary: Get full inventory history across all items
 *     tags: [Inventory History]
 *     description: |
 *       Returns a paginated audit log of every inventory change.
 *       Each row now includes the resolved source document label
 *       (e.g. "Sample: Block A – Tower 2" instead of just "sample / 17").
 *     parameters:
 *       - in: query
 *         name: inventory_id
 *         schema: { type: integer }
 *       - in: query
 *         name: user_id
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: change_type
 *         schema: { type: string, enum: [stock_in, stock_out, adjustment, created, updated] }
 *       - in: query
 *         name: source_type
 *         schema: { type: string, enum: [dc, po, pr, sample, mir, manual] }
 *       - in: query
 *         name: project_id
 *         schema: { type: integer }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: sort
 *         schema: { type: string, enum: [asc, desc], default: desc }
 *     responses:
 *       200:
 *         description: Paginated list with source labels resolved
 *       500:
 *         description: Server error
 */
router.get("/", async (req, res) => {
  try {
    const {
      inventory_id,
      user_id,
      change_type,
      source_type,
      project_id,
      from,
      to,
      page  = 1,
      limit = 20,
      sort  = "desc",
    } = req.query;

    const conditions = [];
    const values     = [];
    let   idx        = 1;

    if (inventory_id) { conditions.push(`h.inventory_id = $${idx++}`); values.push(Number(inventory_id)); }
    if (user_id)      { conditions.push(`h.performed_by = $${idx++}`); values.push(user_id); }
    if (change_type)  { conditions.push(`h.change_type  = $${idx++}`); values.push(change_type); }
    if (source_type)  { conditions.push(`h.source_type  = $${idx++}`); values.push(source_type); }
    if (project_id)   { conditions.push(`h.project_id   = $${idx++}`); values.push(Number(project_id)); }
    if (from)         { conditions.push(`h.created_at  >= $${idx++}`); values.push(from); }
    if (to)           { conditions.push(`h.created_at  <= $${idx++}`); values.push(to + " 23:59:59"); }

    const whereClause = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const sortDir     = sort === "asc" ? "ASC" : "DESC";
    const pageNum     = Math.max(1, parseInt(page)  || 1);
    const limitNum    = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const offset      = (pageNum - 1) * limitNum;

    const dataQuery = `
      SELECT
        h.history_id,
        h.inventory_id,
        h.item_name,
        h.item_brand,
        h.item_units,
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
        ${SOURCE_LABEL_SQL},
        ${SOURCE_DETAIL_SQL},
        h.project_id,
        h.project_name,
        h.notes,
        h.performed_by,
        h.performed_by_name,
        h.changed_fields,
        h.created_at
      FROM inventory_history h
      ${SOURCE_JOINS}
      ${whereClause}
      ORDER BY h.created_at ${sortDir}
      LIMIT $${idx} OFFSET $${idx + 1}
    `;

    const countQuery   = `SELECT COUNT(*) AS total FROM inventory_history h ${whereClause}`;
    const summaryQuery = `
      SELECT
        COUNT(*)                                           AS total_events,
        COALESCE(SUM(h.stock_in),  0)                     AS total_stock_in,
        COALESCE(SUM(h.stock_out), 0)                     AS total_stock_out,
        COUNT(DISTINCT h.inventory_id)                    AS items_affected,
        COUNT(DISTINCT h.performed_by)                    AS unique_users,
        COUNT(CASE WHEN h.change_type = 'stock_in'   THEN 1 END) AS stock_in_events,
        COUNT(CASE WHEN h.change_type = 'stock_out'  THEN 1 END) AS stock_out_events,
        COUNT(CASE WHEN h.change_type = 'adjustment' THEN 1 END) AS adjustment_events,
        COUNT(CASE WHEN h.change_type = 'created'    THEN 1 END) AS created_events,
        COUNT(CASE WHEN h.change_type = 'updated'    THEN 1 END) AS updated_events
      FROM inventory_history h
      ${whereClause}
    `;

    const [dataRes, countRes, summaryRes] = await Promise.all([
      pool.query(dataQuery,    [...values, limitNum, offset]),
      pool.query(countQuery,   values),
      pool.query(summaryQuery, values),
    ]);

    const total      = parseInt(countRes.rows[0].total) || 0;
    const totalPages = Math.ceil(total / limitNum);

    res.json({
      data: dataRes.rows,
      pagination: {
        total,
        total_pages: totalPages,
        current_page: pageNum,
        per_page: limitNum,
        has_next: pageNum < totalPages,
        has_prev: pageNum > 1,
      },
      summary: summaryRes.rows[0],
      filters_applied: {
        inventory_id: inventory_id || null,
        user_id:      user_id      || null,
        change_type:  change_type  || null,
        source_type:  source_type  || null,
        project_id:   project_id   || null,
        from:         from         || null,
        to:           to           || null,
      },
    });
  } catch (err) {
    console.error("Error fetching inventory history:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ★ UPDATED  GET /api/inventory-history/item/:inventory_id
//
// Full history for one item.  Every history row now includes:
//   source_label  – human-readable source (e.g. "Sample: Block A – Tower 2")
//   + PR / Sample / DC / PO detail columns so the frontend can deep-link
//
// This is the main "item history" screen the user lands on after searching.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/inventory-history/item/{inventory_id}:
 *   get:
 *     summary: Full history for one inventory item with resolved source names
 *     tags: [Inventory History]
 *     description: |
 *       Returns all history entries for one item.
 *       Every row includes a resolved source_label:
 *         - "DC: CHN-2024-001" for delivery challans
 *         - "PO: PO-2024-042 (Vendor Name)" for purchase orders
 *         - "PR: Project Name" for purchase requisitions (with PR id)
 *         - "Sample: Block A – Tower 2" for samples
 *         - "MIR: MIR-REF-001" for material inspection reports
 *       Also returns the inventory item's full provenance chain (upstream).
 *     parameters:
 *       - in: path
 *         name: inventory_id
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: change_type
 *         schema: { type: string, enum: [stock_in, stock_out, adjustment, created, updated] }
 *       - in: query
 *         name: source_type
 *         schema: { type: string, enum: [dc, po, pr, sample, mir, manual] }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *       - in: query
 *         name: sort
 *         schema: { type: string, enum: [asc, desc], default: desc }
 *     responses:
 *       200:
 *         description: Inventory item with full richly-labelled history
 *       404:
 *         description: Inventory item not found
 *       500:
 *         description: Server error
 */
router.get("/item/:inventory_id", async (req, res) => {
  try {
    const { inventory_id } = req.params;
    const {
      change_type,
      source_type,
      from,
      to,
      page  = 1,
      limit = 50,
      sort  = "desc",
    } = req.query;

    // ── 1. Fetch the item itself + upstream provenance chain ──────────────────
    const itemRes = await pool.query(
      `SELECT
         i.*,
         -- Source DC
         dc.challan_number   AS src_dc_challan,
         dc.challan_date     AS src_dc_date,
         -- Source PO
         po.order_no         AS src_po_number,
         po.vendor_name      AS src_po_vendor,
         po.po_date          AS src_po_date,
         -- Source PR
         pr.project_name     AS src_pr_project,
         pr.workorder_no     AS src_pr_workorder,
         -- Source Sample
         s.building_name     AS src_sample_building,
         s.site_name         AS src_sample_site,
         s.work_done         AS src_sample_work_done,
         -- Stock totals from history
         COALESCE((SELECT SUM(stock_in)  FROM inventory_history WHERE inventory_id = i.inventory_id), 0) AS total_stock_in,
         COALESCE((SELECT SUM(stock_out) FROM inventory_history WHERE inventory_id = i.inventory_id), 0) AS total_stock_out
       FROM inventories i
       LEFT JOIN delivery_challans     dc ON dc.dc_id    = i.source_dc_id
       LEFT JOIN pos                   po ON po.po_id    = i.source_po_id
       LEFT JOIN purchase_requisitions pr ON pr.pr_id    = i.source_pr_id
       LEFT JOIN samples               s  ON s.sample_id = i.source_sample_id
       WHERE i.inventory_id = $1`,
      [inventory_id]
    );

    if (itemRes.rows.length === 0)
      return res.status(404).json({ error: "Inventory item not found" });

    const raw = itemRes.rows[0];

    // Build upstream chain label parts
    const chainParts = [];
    if (raw.src_dc_challan)       chainParts.push(`DC: ${raw.src_dc_challan}`);
    if (raw.src_po_number)        chainParts.push(`PO: ${raw.src_po_number}${raw.src_po_vendor ? ` (${raw.src_po_vendor})` : ""}`);
    if (raw.src_sample_building)  chainParts.push(`Sample: ${raw.src_sample_building}${raw.src_sample_site ? ` – ${raw.src_sample_site}` : ""}`);

    const item = {
      inventory_id:    raw.inventory_id,
      name:            raw.name,
      brand:           raw.brand,
      units:           raw.units,
      price:           raw.price,
      current_quantity: raw.current_quantity,
      project_id:      raw.project_id,
      created_at:      raw.created_at,
      updated_at:      raw.updated_at,
      total_stock_in:  raw.total_stock_in,
      total_stock_out: raw.total_stock_out,
      // Upstream provenance
      upstream_chain: chainParts.join(" ← ") || "Manual / Direct Entry",
      source: {
        dc: raw.source_dc_id ? {
          dc_id:          raw.source_dc_id,
          challan_number: raw.src_dc_challan,
          challan_date:   raw.src_dc_date,
        } : null,
        po: raw.source_po_id ? {
          po_id:      raw.source_po_id,
          order_no:   raw.src_po_number,
          vendor_name: raw.src_po_vendor,
          po_date:    raw.src_po_date,
        } : null,
        pr: raw.source_pr_id ? {
          pr_id:       raw.source_pr_id,
          project_name: raw.src_pr_project,
          workorder_no: raw.src_pr_workorder,
        } : null,
        sample: raw.source_sample_id ? {
          sample_id:     raw.source_sample_id,
          building_name: raw.src_sample_building,
          site_name:     raw.src_sample_site,
          work_done:     raw.src_sample_work_done,
        } : null,
      },
    };

    // ── 2. Build filters for history rows ────────────────────────────────────
    const conditions = [`h.inventory_id = $1`];
    const values     = [inventory_id];
    let   idx        = 2;

    if (change_type)  { conditions.push(`h.change_type = $${idx++}`); values.push(change_type); }
    if (source_type)  { conditions.push(`h.source_type = $${idx++}`); values.push(source_type); }
    if (from)         { conditions.push(`h.created_at >= $${idx++}`); values.push(from); }
    if (to)           { conditions.push(`h.created_at <= $${idx++}`); values.push(to + " 23:59:59"); }

    const whereClause = "WHERE " + conditions.join(" AND ");
    const sortDir     = sort === "asc" ? "ASC" : "DESC";
    const pageNum     = Math.max(1, parseInt(page)  || 1);
    const limitNum    = Math.min(200, Math.max(1, parseInt(limit) || 50));
    const offset      = (pageNum - 1) * limitNum;

    // ── 3. History query with full source joins ───────────────────────────────
    const historyQuery = `
      SELECT
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

        -- ★ Resolved human-readable label for the source document
        ${SOURCE_LABEL_SQL},

        -- ★ Full detail columns so frontend can render deep-links
        ${SOURCE_DETAIL_SQL},

        h.project_id,
        h.project_name,
        h.notes,
        h.performed_by,
        h.performed_by_name,
        h.changed_fields,
        h.created_at
      FROM inventory_history h
      ${SOURCE_JOINS}
      ${whereClause}
      ORDER BY h.created_at ${sortDir}
      LIMIT $${idx} OFFSET $${idx + 1}
    `;

    const countQuery   = `SELECT COUNT(*) AS total FROM inventory_history h ${whereClause}`;
    const summaryQuery = `
      SELECT
        COUNT(*)                                           AS total_events,
        COALESCE(SUM(h.stock_in),  0)                     AS total_stock_in,
        COALESCE(SUM(h.stock_out), 0)                     AS total_stock_out,
        COUNT(DISTINCT h.performed_by)                    AS unique_users,
        COUNT(CASE WHEN h.change_type = 'stock_in'   THEN 1 END) AS stock_in_events,
        COUNT(CASE WHEN h.change_type = 'stock_out'  THEN 1 END) AS stock_out_events,
        COUNT(CASE WHEN h.change_type = 'adjustment' THEN 1 END) AS adjustment_events,
        MIN(h.created_at)                                  AS first_event_at,
        MAX(h.created_at)                                  AS last_event_at
      FROM inventory_history h
      ${whereClause}
    `;

    const [historyRes, countRes, summaryRes] = await Promise.all([
      pool.query(historyQuery,  [...values, limitNum, offset]),
      pool.query(countQuery,    values),
      pool.query(summaryQuery,  values),
    ]);

    const total      = parseInt(countRes.rows[0].total) || 0;
    const totalPages = Math.ceil(total / limitNum);

    res.json({
      item,
      history: historyRes.rows,
      pagination: {
        total,
        total_pages: totalPages,
        current_page: pageNum,
        per_page: limitNum,
        has_next: pageNum < totalPages,
        has_prev: pageNum > 1,
      },
      summary: summaryRes.rows[0],
      filters_applied: {
        change_type:  change_type  || null,
        source_type:  source_type  || null,
        from:         from         || null,
        to:           to           || null,
      },
    });
  } catch (err) {
    console.error("Error fetching item inventory history:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inventory-history/user/:user_id
// All inventory changes made by a specific user
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/inventory-history/user/{user_id}:
 *   get:
 *     summary: Get all inventory changes made by a specific user
 *     tags: [Inventory History]
 *     parameters:
 *       - in: path
 *         name: user_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: change_type
 *         schema: { type: string, enum: [stock_in, stock_out, adjustment, created, updated] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: History of all changes made by the user
 *       500:
 *         description: Server error
 */
router.get("/user/:user_id", async (req, res) => {
  try {
    const { user_id }   = req.params;
    const { from, to, change_type, page = 1, limit = 20, sort = "desc" } = req.query;

    const conditions = [`h.performed_by = $1`];
    const values     = [user_id];
    let   idx        = 2;

    if (change_type) { conditions.push(`h.change_type = $${idx++}`); values.push(change_type); }
    if (from)        { conditions.push(`h.created_at >= $${idx++}`); values.push(from); }
    if (to)          { conditions.push(`h.created_at <= $${idx++}`); values.push(to + " 23:59:59"); }

    const whereClause = "WHERE " + conditions.join(" AND ");
    const sortDir  = sort === "asc" ? "ASC" : "DESC";
    const pageNum  = Math.max(1, parseInt(page)  || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const offset   = (pageNum - 1) * limitNum;

    const dataQuery = `
      SELECT
        h.history_id,
        h.inventory_id,
        h.item_name,
        h.item_brand,
        h.item_units,
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
        h.source_ref,
        ${SOURCE_LABEL_SQL},
        h.project_name,
        h.notes,
        h.performed_by,
        h.performed_by_name,
        h.created_at
      FROM inventory_history h
      ${SOURCE_JOINS}
      ${whereClause}
      ORDER BY h.created_at ${sortDir}
      LIMIT $${idx} OFFSET $${idx + 1}
    `;

    const countQuery   = `SELECT COUNT(*) AS total FROM inventory_history h ${whereClause}`;
    const summaryQuery = `
      SELECT
        h.performed_by_name,
        COUNT(*)                          AS total_actions,
        SUM(h.stock_in)                   AS total_stock_in,
        SUM(h.stock_out)                  AS total_stock_out,
        COUNT(DISTINCT h.inventory_id)    AS items_touched,
        MIN(h.created_at)                 AS first_action_at,
        MAX(h.created_at)                 AS last_action_at
      FROM inventory_history h
      ${whereClause}
      GROUP BY h.performed_by_name
    `;

    const [dataRes, countRes, summaryRes] = await Promise.all([
      pool.query(dataQuery,    [...values, limitNum, offset]),
      pool.query(countQuery,   values),
      pool.query(summaryQuery, values),
    ]);

    const total      = parseInt(countRes.rows[0].total) || 0;
    const totalPages = Math.ceil(total / limitNum);

    res.json({
      user: {
        user_id,
        user_name: summaryRes.rows[0]?.performed_by_name || null,
      },
      history: dataRes.rows,
      pagination: {
        total,
        total_pages: totalPages,
        current_page: pageNum,
        per_page: limitNum,
        has_next: pageNum < totalPages,
        has_prev: pageNum > 1,
      },
      summary: summaryRes.rows[0] || {},
    });
  } catch (err) {
    console.error("Error fetching user inventory history:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inventory-history/summary
// High-level dashboard summary: top movers, top users, daily activity
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/inventory-history/summary:
 *   get:
 *     summary: Dashboard summary of inventory history
 *     tags: [Inventory History]
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Summary statistics
 *       500:
 *         description: Server error
 */
router.get("/summary", async (req, res) => {
  try {
    const {
      from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      to   = new Date().toISOString().split("T")[0],
    } = req.query;

    const dateFilter = `h.created_at BETWEEN $1 AND $2`;
    const dateValues = [from, to + " 23:59:59"];

    const [overallRes, topItemsRes, topUsersRes, dailyRes] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)                                           AS total_events,
          COALESCE(SUM(h.stock_in),  0)                     AS total_stock_in,
          COALESCE(SUM(h.stock_out), 0)                     AS total_stock_out,
          COUNT(DISTINCT h.inventory_id)                    AS unique_items,
          COUNT(DISTINCT h.performed_by)                    AS unique_users,
          COUNT(CASE WHEN h.change_type = 'stock_in'   THEN 1 END) AS stock_in_count,
          COUNT(CASE WHEN h.change_type = 'stock_out'  THEN 1 END) AS stock_out_count,
          COUNT(CASE WHEN h.change_type = 'adjustment' THEN 1 END) AS adjustment_count
        FROM inventory_history h
        WHERE ${dateFilter}
      `, dateValues),

      pool.query(`
        SELECT
          h.inventory_id,
          h.item_name,
          h.item_brand,
          h.item_units,
          COUNT(*)              AS event_count,
          SUM(h.stock_in)       AS total_in,
          SUM(h.stock_out)      AS total_out,
          MAX(h.created_at)     AS last_updated_at,
          MAX(h.performed_by_name) AS last_updated_by
        FROM inventory_history h
        WHERE ${dateFilter}
        GROUP BY h.inventory_id, h.item_name, h.item_brand, h.item_units
        ORDER BY event_count DESC
        LIMIT 10
      `, dateValues),

      pool.query(`
        SELECT
          h.performed_by,
          h.performed_by_name,
          COUNT(*)                        AS total_actions,
          SUM(h.stock_in)                 AS total_stock_in,
          SUM(h.stock_out)                AS total_stock_out,
          COUNT(DISTINCT h.inventory_id)  AS items_touched,
          MAX(h.created_at)               AS last_action_at,
          COUNT(CASE WHEN h.change_type = 'stock_in'  THEN 1 END) AS stock_in_actions,
          COUNT(CASE WHEN h.change_type = 'stock_out' THEN 1 END) AS stock_out_actions
        FROM inventory_history h
        WHERE ${dateFilter}
          AND h.performed_by IS NOT NULL
        GROUP BY h.performed_by, h.performed_by_name
        ORDER BY total_actions DESC
        LIMIT 10
      `, dateValues),

      pool.query(`
        SELECT
          DATE(h.created_at)            AS activity_date,
          COUNT(*)                       AS event_count,
          COALESCE(SUM(h.stock_in),  0) AS stock_in,
          COALESCE(SUM(h.stock_out), 0) AS stock_out,
          COUNT(DISTINCT h.performed_by) AS active_users
        FROM inventory_history h
        WHERE ${dateFilter}
        GROUP BY DATE(h.created_at)
        ORDER BY activity_date ASC
      `, dateValues),
    ]);

    res.json({
      period:         { from, to },
      overall:        overallRes.rows[0],
      top_items:      topItemsRes.rows,
      top_users:      topUsersRes.rows,
      daily_activity: dailyRes.rows,
    });
  } catch (err) {
    console.error("Error fetching inventory history summary:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inventory-history/:history_id
// Single history entry by ID
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/inventory-history/{history_id}:
 *   get:
 *     summary: Get a single inventory history entry
 *     tags: [Inventory History]
 *     parameters:
 *       - in: path
 *         name: history_id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: History entry with resolved source label
 *       404:
 *         description: Not found
 *       500:
 *         description: Server error
 */
router.get("/:history_id", async (req, res) => {
  try {
    const { history_id } = req.params;

    const result = await pool.query(
      `SELECT
         h.*,
         CASE h.change_type
           WHEN 'stock_in'   THEN 'Stock In'
           WHEN 'stock_out'  THEN 'Stock Out'
           WHEN 'adjustment' THEN 'Adjustment'
           WHEN 'created'    THEN 'Item Created'
           WHEN 'updated'    THEN 'Item Updated'
           WHEN 'deleted'    THEN 'Item Deleted'
           ELSE h.change_type
         END AS change_type_label,
         CASE h.source_type
           WHEN 'dc'     THEN 'Delivery Challan'
           WHEN 'po'     THEN 'Purchase Order'
           WHEN 'pr'     THEN 'Purchase Request'
           WHEN 'sample' THEN 'Sample'
           WHEN 'mir'    THEN 'MIR'
           WHEN 'manual' THEN 'Manual Entry'
           ELSE COALESCE(h.source_type, 'Unknown')
         END AS source_type_label,
         (h.balance_after - h.balance_before) AS net_change,
         ${SOURCE_LABEL_SQL},
         ${SOURCE_DETAIL_SQL}
       FROM inventory_history h
       ${SOURCE_JOINS}
       WHERE h.history_id = $1`,
      [history_id]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "History entry not found" });

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching history entry:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────
module.exports = router;
module.exports.logInventoryHistory = logInventoryHistory;