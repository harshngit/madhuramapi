const express = require("express");
const router = express.Router();
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
 *       Shows who made each update, stock-in and stock-out quantities,
 *       balance before/after, source document, and timestamps.
 *       Supports filtering by item, user, change type, date range, and project.
 *     parameters:
 *       - in: query
 *         name: inventory_id
 *         schema: { type: integer }
 *         description: Filter by specific inventory item ID
 *       - in: query
 *         name: user_id
 *         schema: { type: string, format: uuid }
 *         description: Filter by user who made the change
 *       - in: query
 *         name: change_type
 *         schema:
 *           type: string
 *           enum: [stock_in, stock_out, adjustment, created, updated]
 *         description: Filter by type of change
 *       - in: query
 *         name: source_type
 *         schema:
 *           type: string
 *           enum: [dc, po, pr, sample, mir, manual]
 *         description: Filter by source document type
 *       - in: query
 *         name: project_id
 *         schema: { type: integer }
 *         description: Filter by project
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *         description: Start date (inclusive) e.g. 2024-01-01
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *         description: End date (inclusive) e.g. 2024-12-31
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
 *         description: Paginated list of inventory history records with summary totals
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

    // ── Build WHERE clauses dynamically ───────────────────────
    const conditions = [];
    const values     = [];
    let   idx        = 1;

    if (inventory_id) {
      conditions.push(`h.inventory_id = $${idx++}`);
      values.push(Number(inventory_id));
    }
    if (user_id) {
      conditions.push(`h.performed_by = $${idx++}`);
      values.push(user_id);
    }
    if (change_type) {
      conditions.push(`h.change_type = $${idx++}`);
      values.push(change_type);
    }
    if (source_type) {
      conditions.push(`h.source_type = $${idx++}`);
      values.push(source_type);
    }
    if (project_id) {
      conditions.push(`h.project_id = $${idx++}`);
      values.push(Number(project_id));
    }
    if (from) {
      conditions.push(`h.created_at >= $${idx++}`);
      values.push(from);
    }
    if (to) {
      conditions.push(`h.created_at <= $${idx++}`);
      values.push(to + " 23:59:59");
    }

    const whereClause = conditions.length
      ? "WHERE " + conditions.join(" AND ")
      : "";

    const sortDir  = sort === "asc" ? "ASC" : "DESC";
    const pageNum  = Math.max(1, parseInt(page)  || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const offset   = (pageNum - 1) * limitNum;

    // ── Main data query ───────────────────────────────────────
    const dataQuery = `
      SELECT
        h.history_id,
        h.inventory_id,
        h.item_name,
        h.item_brand,
        h.item_units,
        h.change_type,
        -- Human-readable label
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
        h.project_id,
        h.project_name,
        h.notes,
        h.performed_by,
        h.performed_by_name,
        h.changed_fields,
        h.created_at
      FROM inventory_history h
      ${whereClause}
      ORDER BY h.created_at ${sortDir}
      LIMIT $${idx} OFFSET $${idx + 1}
    `;

    // ── Count query for pagination ────────────────────────────
    const countQuery = `
      SELECT COUNT(*) AS total
      FROM inventory_history h
      ${whereClause}
    `;

    // ── Summary / aggregates query ────────────────────────────
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

    // Run all three queries in parallel
    const [dataRes, countRes, summaryRes] = await Promise.all([
      pool.query(dataQuery,   [...values, limitNum, offset]),
      pool.query(countQuery,  values),
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
// GET /api/inventory-history/item/:inventory_id
// History for a single inventory item — detailed view with item info
//
// Query params: same filters as above (except inventory_id which is in path)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/inventory-history/item/{inventory_id}:
 *   get:
 *     summary: Get full history for a single inventory item
 *     tags: [Inventory History]
 *     description: |
 *       Returns all history entries for one specific inventory item.
 *       Includes item details, movement log with user info,
 *       stock-in/stock-out per event, and aggregate summary.
 *     parameters:
 *       - in: path
 *         name: inventory_id
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: change_type
 *         schema: { type: string, enum: [stock_in, stock_out, adjustment, created, updated] }
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
 *     responses:
 *       200:
 *         description: Inventory item with full history
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
      from,
      to,
      page  = 1,
      limit = 50,
      sort  = "desc",
    } = req.query;

    // Verify item exists
    const itemRes = await pool.query(
      `SELECT
         i.*,
         COALESCE(
           (SELECT SUM(stock_in)  FROM inventory_history WHERE inventory_id = i.inventory_id),
           0
         ) AS total_stock_in,
         COALESCE(
           (SELECT SUM(stock_out) FROM inventory_history WHERE inventory_id = i.inventory_id),
           0
         ) AS total_stock_out
       FROM inventories i
       WHERE i.inventory_id = $1`,
      [inventory_id]
    );

    if (itemRes.rows.length === 0)
      return res.status(404).json({ error: "Inventory item not found" });

    const item = itemRes.rows[0];

    // ── Build filters ──────────────────────────────────────────
    const conditions = [`h.inventory_id = $1`];
    const values     = [inventory_id];
    let   idx        = 2;

    if (change_type) {
      conditions.push(`h.change_type = $${idx++}`);
      values.push(change_type);
    }
    if (from) {
      conditions.push(`h.created_at >= $${idx++}`);
      values.push(from);
    }
    if (to) {
      conditions.push(`h.created_at <= $${idx++}`);
      values.push(to + " 23:59:59");
    }

    const whereClause = "WHERE " + conditions.join(" AND ");
    const sortDir     = sort === "asc" ? "ASC" : "DESC";
    const pageNum     = Math.max(1, parseInt(page)  || 1);
    const limitNum    = Math.min(200, Math.max(1, parseInt(limit) || 50));
    const offset      = (pageNum - 1) * limitNum;

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
        h.project_id,
        h.project_name,
        h.notes,
        h.performed_by,
        h.performed_by_name,
        h.changed_fields,
        h.created_at
      FROM inventory_history h
      ${whereClause}
      ORDER BY h.created_at ${sortDir}
      LIMIT $${idx} OFFSET $${idx + 1}
    `;

    const countQuery = `
      SELECT COUNT(*) AS total FROM inventory_history h ${whereClause}
    `;

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
 *         description: UUID of the user
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
        h.project_name,
        h.notes,
        h.performed_by,
        h.performed_by_name,
        h.created_at
      FROM inventory_history h
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
 *     description: |
 *       Returns aggregated stats for inventory history:
 *       - Overall totals (events, stock-in, stock-out)
 *       - Top items by movement frequency
 *       - Top users by number of actions
 *       - Daily activity over the last 30 days
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *         description: Start date filter (default last 30 days)
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

    const dateFilter  = `h.created_at BETWEEN $1 AND $2`;
    const dateValues  = [from, to + " 23:59:59"];

    const [overallRes, topItemsRes, topUsersRes, dailyRes] = await Promise.all([

      // ── Overall totals ───────────────────────────────────────
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

      // ── Top 10 most active items ─────────────────────────────
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

      // ── Top 10 most active users ─────────────────────────────
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

      // ── Daily activity (last N days) ─────────────────────────
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
      period: { from, to },
      overall:    overallRes.rows[0],
      top_items:  topItemsRes.rows,
      top_users:  topUsersRes.rows,
      daily_activity: dailyRes.rows,
    });
  } catch (err) {
    console.error("Error fetching inventory history summary:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inventory-history/:history_id
// Fetch a single history entry by its ID
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
 *         description: History entry
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
         (h.balance_after - h.balance_before) AS net_change
       FROM inventory_history h
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
