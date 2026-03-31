/**
 * routes/inventory_trace.js
 *
 * Complete inventory traceability for the real business flow:
 *   Sample → PR → PO → DC → Inventory
 *
 * The chain is already in your DB via foreign keys:
 *   delivery_challans.po_id  → pos.po_id
 *   pos.sample_id            → samples.sample_id
 *   purchase_requisitions.sample_id → samples.sample_id
 *
 * When DC creates inventory items, we now walk BACKWARDS through
 * that chain to stamp source_sample_id, source_pr_id, source_po_id
 * onto every inventory row — so full provenance is stored forever.
 *
 * Register in index.js:
 *   const traceRoutes = require("./routes/inventory_trace");
 *   app.use("/api/inventory-trace", traceRoutes);
 *
 * Also update delivery_challan.js syncDCToInventory() to call:
 *   const { stampInventoryChain } = require("./inventory_trace");
 *   await stampInventoryChain(client, inventoryId, dcId);
 *
 * ─── Endpoints ────────────────────────────────────────────────────────────────
 *
 * SEARCH
 *   GET  /api/inventory-trace/search?q=tile&project_id=3
 *
 * AUTO-MATCH
 *   POST /api/inventory-trace/match/pr/:prId
 *   POST /api/inventory-trace/match/sample/:sampleId
 *
 * FULL CHAIN TRACE
 *   GET  /api/inventory-trace/chain/inventory/:inventoryId   ← main one
 *   GET  /api/inventory-trace/chain/sample/:sampleId
 *   GET  /api/inventory-trace/chain/pr/:prId
 *   GET  /api/inventory-trace/chain/dc/:dcId
 */

const express = require("express");
const router  = express.Router();
const { pool } = require("../db");
const { logActivity } = require("./dashboard");

// ─────────────────────────────────────────────────────────────────────────────
// CORE HELPER: walk upstream chain for a DC
// DC → PO → Sample → PR (the PR that started the whole need)
// ─────────────────────────────────────────────────────────────────────────────
async function resolveUpstreamChain(dcId) {
  const result = await pool.query(
    `SELECT
       po.po_id,
       po.order_no          AS po_order_no,
       po.vendor_name,
       po.po_date,
       po.sample_id         AS po_sample_id,
       s.sample_id,
       s.building_name,
       s.site_name,
       s.work_done,
       pr.pr_id,
       pr.project_name      AS pr_project_name,
       pr.workorder_no
     FROM delivery_challans dc
     LEFT JOIN pos          po ON po.po_id    = dc.po_id
     LEFT JOIN samples      s  ON s.sample_id = po.sample_id
     LEFT JOIN purchase_requisitions pr
                               ON pr.sample_id = s.sample_id
                              AND pr.project_id = COALESCE(po.project_id, dc.project_id)
     WHERE dc.dc_id = $1
     LIMIT 1`,
    [dcId]
  );

  if (!result.rows.length) return null;
  const r = result.rows[0];
  return {
    po:     r.po_id     ? { po_id: r.po_id, order_no: r.po_order_no, vendor_name: r.vendor_name, po_date: r.po_date } : null,
    sample: r.sample_id ? { sample_id: r.sample_id, building_name: r.building_name, site_name: r.site_name } : null,
    pr:     r.pr_id     ? { pr_id: r.pr_id, project_name: r.pr_project_name, workorder_no: r.workorder_no } : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE HELPER: stamp full upstream chain onto an inventory row
// Called from delivery_challan.js after inserting inventory item
// ─────────────────────────────────────────────────────────────────────────────
async function stampInventoryChain(client, inventoryId, dcId) {
  const chain = await resolveUpstreamChain(dcId);
  if (!chain) return;
  await client.query(
    `UPDATE inventories
        SET source_dc_id     = $1,
            source_po_id     = $2,
            source_pr_id     = $3,
            source_sample_id = $4,
            updated_at       = NOW()
      WHERE inventory_id = $5`,
    [
      dcId,
      chain.po     ? chain.po.po_id         : null,
      chain.pr     ? chain.pr.pr_id         : null,
      chain.sample ? chain.sample.sample_id : null,
      inventoryId,
    ]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE HELPER: fuzzy name matching
// ─────────────────────────────────────────────────────────────────────────────
function normalize(str) {
  return String(str || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

function wordOverlap(a, b) {
  const wa = new Set(normalize(a).split(/\s+/).filter(Boolean));
  const wb = new Set(normalize(b).split(/\s+/).filter(Boolean));
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.max(wa.size, wb.size);
}

async function findBestInventoryMatch(itemName, projectId) {
  if (!itemName) return null;
  const words = normalize(itemName).split(/\s+/).filter(w => w.length > 2);
  if (!words.length) return null;

  const likeClauses = words.map((_, i) => `i.name ILIKE $${i + 2}`).join(" OR ");
  const result = await pool.query(
    `SELECT i.inventory_id, i.name, i.brand, i.units, i.current_quantity,
            i.source_dc_id, i.source_po_id, i.source_sample_id, i.project_id,
            dc.challan_number, dc.challan_date
       FROM inventories i
       LEFT JOIN delivery_challans dc ON dc.dc_id = i.source_dc_id
      WHERE (${likeClauses})
        AND i.current_quantity > 0
        AND ($1::int IS NULL OR i.project_id = $1 OR i.project_id IS NULL)
      ORDER BY CASE WHEN i.project_id = $1 THEN 0 ELSE 1 END, i.current_quantity DESC
      LIMIT 10`,
    [projectId || null, ...words.map(w => `%${w}%`)]
  );

  if (!result.rows.length) return null;
  let best = null, bestScore = 0;
  for (const row of result.rows) {
    const score = wordOverlap(row.name, itemName);
    if (score > bestScore) { bestScore = score; best = row; }
  }
  return bestScore >= 0.5 ? best : null;
}

function buildChainLabel(r) {
  const parts = [];
  if (r.challan_number || r.dc_challan) parts.push(`DC: ${r.challan_number || r.dc_challan}`);
  if (r.po_number || r.po_order_no)    parts.push(`PO: ${r.po_number || r.po_order_no}`);
  if (r.sample_building)               parts.push(`Sample: ${r.sample_building}`);
  return parts.join(" ← ") || "Manual entry";
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inventory-trace/search
// Powers the frontend dropdown: user types item name while creating PR/Sample
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/inventory-trace/search:
 *   get:
 *     summary: Search inventory items by name (for PR/Sample dropdowns)
 *     tags: [InventoryTrace]
 *     description: |
 *       Use this to populate item-picker dropdowns in PR and Sample forms.
 *       Each result includes the full upstream chain label so the user can
 *       confirm: "Yes, this is the Tile 60x60 that came from DC-2024-001 for Block A."
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: project_id
 *         schema: { type: integer }
 *       - in: query
 *         name: min_qty
 *         schema: { type: number }
 *     responses:
 *       200:
 *         description: Matching inventory items with source chain label
 */
router.get("/search", async (req, res) => {
  try {
    const { q, project_id, min_qty = 0 } = req.query;
    if (!q || !q.trim()) return res.status(400).json({ error: "Query param 'q' is required" });

    const result = await pool.query(
      `SELECT
         i.inventory_id,
         i.name,
         i.brand,
         i.units,
         i.price,
         i.current_quantity     AS available_qty,
         i.project_id,
         dc.challan_number,
         dc.challan_date,
         po.order_no            AS po_number,
         po.vendor_name,
         s.building_name        AS sample_building,
         CASE WHEN i.project_id = $3 THEN true ELSE false END AS same_project
       FROM inventories i
       LEFT JOIN delivery_challans dc ON dc.dc_id    = i.source_dc_id
       LEFT JOIN pos               po ON po.po_id    = i.source_po_id
       LEFT JOIN samples           s  ON s.sample_id = i.source_sample_id
      WHERE (i.name ILIKE $1 OR i.brand ILIKE $1)
        AND i.current_quantity >= $2
      ORDER BY
        CASE WHEN i.project_id = $3 THEN 0 ELSE 1 END,
        i.current_quantity DESC,
        i.updated_at DESC
      LIMIT 20`,
      [`%${q.trim()}%`, Number(min_qty) || 0, project_id ? Number(project_id) : null]
    );

    res.json({
      count: result.rows.length,
      items: result.rows.map(r => ({
        inventory_id:  r.inventory_id,
        name:          r.name,
        brand:         r.brand,
        units:         r.units,
        price:         r.price,
        available_qty: r.available_qty,
        same_project:  r.same_project,
        source_chain_label: buildChainLabel(r),
      })),
    });
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inventory-trace/match/pr/:prId
//
// Two strategies, strongest first:
//  1. Chain match: PR → sample_id → inventories.source_sample_id + name similarity
//  2. Name fuzzy match across project inventory
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/inventory-trace/match/pr/{prId}:
 *   post:
 *     summary: Auto-link unmatched PR items to inventory by name / chain
 *     tags: [InventoryTrace]
 *     description: |
 *       For each PR line item with no inventory_id, tries two strategies:
 *       1. Chain match: finds inventory whose source_sample_id matches this PR's
 *          sample_id AND name is similar (strongest — uses the real FK chain)
 *       2. Name fuzzy match as fallback
 *       Writes inventory_id back. Does NOT deduct stock.
 *     parameters:
 *       - in: path
 *         name: prId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Match results with strategy used per item
 *       404:
 *         description: PR not found
 */
router.post("/match/pr/:prId", async (req, res) => {
  try {
    const { prId } = req.params;
    const { force = false } = req.body;

    const prRes = await pool.query(
      "SELECT * FROM purchase_requisitions WHERE pr_id = $1",
      [prId]
    );
    if (!prRes.rows.length) return res.status(404).json({ error: "PR not found" });
    const pr = prRes.rows[0];

    const itemsRes = await pool.query(
      `SELECT * FROM purchase_requisition_items
        WHERE pr_id=$1 AND ($2=true OR inventory_id IS NULL)
        ORDER BY pr_item_id`,
      [prId, force]
    );

    const results = [];

    for (const item of itemsRes.rows) {
      const name = item.material_description;
      if (!name) { results.push({ pr_item_id: item.pr_item_id, status: "skipped" }); continue; }

      let match = null;

      // Strategy 1: chain match via sample_id
      if (pr.sample_id) {
        const chainRes = await pool.query(
          `SELECT i.*, dc.challan_number, dc.challan_date
             FROM inventories i
             LEFT JOIN delivery_challans dc ON dc.dc_id = i.source_dc_id
            WHERE i.source_sample_id = $1 AND i.current_quantity > 0
            ORDER BY i.current_quantity DESC LIMIT 10`,
          [pr.sample_id]
        );
        let best = null, bestScore = 0;
        for (const row of chainRes.rows) {
          const s = wordOverlap(row.name, name);
          if (s > bestScore) { bestScore = s; best = row; }
        }
        if (bestScore >= 0.5) { match = best; match._strategy = "chain"; }
      }

      // Strategy 2: name fuzzy
      if (!match) {
        match = await findBestInventoryMatch(name, pr.project_id);
        if (match) match._strategy = "name_fuzzy";
      }

      if (!match) {
        results.push({
          pr_item_id: item.pr_item_id,
          material_description: name,
          status: "unmatched",
          tip: `Ensure a DC was received against the PO linked to Sample #${pr.sample_id || "?"}.`,
        });
        continue;
      }

      await pool.query(
        "UPDATE purchase_requisition_items SET inventory_id=$1 WHERE pr_item_id=$2",
        [match.inventory_id, item.pr_item_id]
      );

      results.push({
        pr_item_id: item.pr_item_id,
        material_description: name,
        status: "matched",
        strategy: match._strategy,
        matched_inventory: {
          inventory_id:     match.inventory_id,
          name:             match.name,
          current_quantity: match.current_quantity,
          units:            match.units,
          challan_number:   match.challan_number || null,
        },
      });
    }

    const matched   = results.filter(r => r.status === "matched").length;
    const unmatched = results.filter(r => r.status === "unmatched").length;

    res.json({
      pr_id: Number(prId),
      total: results.length, matched, unmatched,
      by_chain_match: results.filter(r => r.strategy === "chain").length,
      by_name_match:  results.filter(r => r.strategy === "name_fuzzy").length,
      items: results,
    });

    logActivity({
      action: "inventory_matched", entity_type: "pr",
      entity_id: prId, entity_name: `PR #${prId}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: pr.project_id,
      meta: { matched, unmatched },
    });
  } catch (err) {
    console.error("PR match error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inventory-trace/match/sample/:sampleId
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/inventory-trace/match/sample/{sampleId}:
 *   post:
 *     summary: Auto-link unmatched Sample items to inventory
 *     tags: [InventoryTrace]
 *     parameters:
 *       - in: path
 *         name: sampleId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Match results per item
 *       404:
 *         description: Sample not found
 */
router.post("/match/sample/:sampleId", async (req, res) => {
  try {
    const { sampleId } = req.params;
    const { force = false } = req.body;

    const sampleRes = await pool.query("SELECT * FROM samples WHERE sample_id=$1", [sampleId]);
    if (!sampleRes.rows.length) return res.status(404).json({ error: "Sample not found" });
    const sample = sampleRes.rows[0];
    const items  = Array.isArray(sample.item_description) ? sample.item_description : [];

    // Pre-load all inventory items sourced from this sample (chain match candidates)
    const chainRows = await pool.query(
      `SELECT i.*, dc.challan_number FROM inventories i
       LEFT JOIN delivery_challans dc ON dc.dc_id = i.source_dc_id
       WHERE i.source_sample_id=$1 AND i.current_quantity > 0`,
      [sampleId]
    );

    let changed = false;
    const results = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const name = item.description || item.name;
      if (!name) { results.push({ index: i, status: "skipped" }); continue; }
      if (item.inventory_id && !force) { results.push({ index: i, status: "already_linked", inventory_id: item.inventory_id }); continue; }

      // Strategy 1: chain match
      let match = null;
      let bestScore = 0;
      for (const row of chainRows.rows) {
        const s = wordOverlap(row.name, name);
        if (s > bestScore) { bestScore = s; match = row; }
      }
      if (bestScore >= 0.5) {
        match._strategy = "chain";
      } else {
        match = await findBestInventoryMatch(name, sample.project_id);
        if (match) match._strategy = "name_fuzzy";
      }

      if (!match) {
        results.push({ index: i, description: name, status: "unmatched",
          tip: "Ensure a DC was received against a PO linked to this sample." });
        continue;
      }

      items[i] = { ...item, inventory_id: match.inventory_id };
      changed = true;

      results.push({
        index: i, description: name, status: "matched",
        strategy: match._strategy,
        matched_inventory: {
          inventory_id: match.inventory_id,
          name: match.name,
          current_quantity: match.current_quantity,
          challan_number: match.challan_number || null,
        },
      });
    }

    if (changed) {
      await pool.query(
        "UPDATE samples SET item_description=$1, updated_at=NOW() WHERE sample_id=$2",
        [JSON.stringify(items), sampleId]
      );
    }

    res.json({
      sample_id: Number(sampleId),
      total: results.length,
      matched: results.filter(r => r.status === "matched").length,
      unmatched: results.filter(r => r.status === "unmatched").length,
      by_chain_match: results.filter(r => r.strategy === "chain").length,
      by_name_match: results.filter(r => r.strategy === "name_fuzzy").length,
      items: results,
    });
  } catch (err) {
    console.error("Sample match error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inventory-trace/chain/inventory/:inventoryId
// THE KEY ENDPOINT — full life of one inventory item
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/inventory-trace/chain/inventory/{inventoryId}:
 *   get:
 *     summary: Complete provenance chain for one inventory item
 *     tags: [InventoryTrace]
 *     description: |
 *       UPSTREAM (how it got here):
 *         Sample → PR → PO → DC → Inventory
 *
 *       DOWNSTREAM (where it went):
 *         → PR issued / Sample consumed / MIR inspected
 *     parameters:
 *       - in: path
 *         name: inventoryId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Full provenance + usage timeline
 *       404:
 *         description: Not found
 */
router.get("/chain/inventory/:inventoryId", async (req, res) => {
  try {
    const { inventoryId } = req.params;

    const invRes = await pool.query(
      `SELECT i.*,
              dc.dc_id,         dc.challan_number, dc.challan_date,
              po.po_id,         po.order_no AS po_number, po.vendor_name, po.po_date,
              pr.pr_id,         pr.project_name AS pr_project, pr.workorder_no,
              s.sample_id,      s.building_name AS sample_building, s.site_name, s.work_done
       FROM inventories i
       LEFT JOIN delivery_challans     dc ON dc.dc_id    = i.source_dc_id
       LEFT JOIN pos                   po ON po.po_id    = i.source_po_id
       LEFT JOIN purchase_requisitions pr ON pr.pr_id    = i.source_pr_id
       LEFT JOIN samples               s  ON s.sample_id = i.source_sample_id
       WHERE i.inventory_id = $1`,
      [inventoryId]
    );
    if (!invRes.rows.length) return res.status(404).json({ error: "Inventory item not found" });
    const inv = invRes.rows[0];

    const movRes = await pool.query(
      `SELECT m.*,
              s2.building_name    AS usage_sample,
              pr2.project_name    AS usage_pr_project,
              mir.mir_refrence_no AS usage_mir_ref,
              dc2.challan_number  AS usage_dc_challan
       FROM inventory_movements m
       LEFT JOIN samples               s2  ON m.source_type='sample' AND s2.sample_id =m.source_id
       LEFT JOIN purchase_requisitions pr2 ON m.source_type='pr'    AND pr2.pr_id    =m.source_id
       LEFT JOIN mirs                  mir ON m.source_type='mir'   AND mir.mir_id   =m.source_id
       LEFT JOIN delivery_challans     dc2 ON m.source_type='dc'    AND dc2.dc_id    =m.source_id
       WHERE m.inventory_id=$1 ORDER BY m.created_at ASC`,
      [inventoryId]
    );

    const movements = movRes.rows;
    const totalIn   = movements.filter(m => m.movement_type === "in") .reduce((a, m) => a + Number(m.quantity), 0);
    const totalOut  = movements.filter(m => m.movement_type === "out").reduce((a, m) => a + Number(m.quantity), 0);

    res.json({
      item: {
        inventory_id:    inv.inventory_id,
        name:            inv.name,
        brand:           inv.brand,
        units:           inv.units,
        price:           inv.price,
        current_balance: inv.current_quantity,
      },

      // UPSTREAM: the complete chain from requirement to stock
      upstream_chain: {
        sample: inv.sample_id ? {
          sample_id:     inv.sample_id,
          building_name: inv.sample_building,
          site_name:     inv.sample_site,
          work_done:     inv.work_done,
          label: `Sample: ${inv.sample_building || inv.sample_site || `#${inv.sample_id}`}`,
        } : null,
        pr: inv.pr_id ? {
          pr_id:       inv.pr_id,
          project:     inv.pr_project,
          workorder_no:inv.workorder_no,
          label: `PR #${inv.pr_id}${inv.pr_project ? ` – ${inv.pr_project}` : ""}`,
        } : null,
        po: inv.po_id ? {
          po_id:      inv.po_id,
          order_no:   inv.po_number,
          vendor_name:inv.vendor_name,
          po_date:    inv.po_date,
          label: `PO: ${inv.po_number || `#${inv.po_id}`}${inv.vendor_name ? ` (${inv.vendor_name})` : ""}`,
        } : null,
        dc: inv.dc_id ? {
          dc_id:          inv.dc_id,
          challan_number: inv.challan_number,
          challan_date:   inv.challan_date,
          label: `DC: ${inv.challan_number}`,
        } : null,
      },

      summary: {
        total_stocked_in: totalIn,
        total_consumed:   totalOut,
        current_balance:  inv.current_quantity,
        movement_count:   movements.length,
      },

      // DOWNSTREAM: every usage event in chronological order
      timeline: movements.map(m => ({
        movement_id:   m.movement_id,
        date:          m.created_at,
        type:          m.movement_type,
        quantity:      Number(m.quantity),
        balance_after: Number(m.balance_after),
        label: m.movement_type === "in"
          ? `Stocked in – ${m.usage_dc_challan || m.source_ref || "DC"}`
          : m.source_type === "pr"     ? `Issued to PR #${m.source_id}${m.usage_pr_project ? ` – ${m.usage_pr_project}` : ""}`
          : m.source_type === "sample" ? `Used in Sample: ${m.usage_sample || `#${m.source_id}`}`
          : m.source_type === "mir"    ? `MIR: ${m.usage_mir_ref || `#${m.source_id}`}`
          : m.source_type === "manual" ? `Manual ${m.movement_type}`
          : m.source_ref || m.source_type,
        source: { type: m.source_type, id: m.source_id, ref: m.source_ref },
        notes:        m.notes,
        performed_by: m.performed_by_name,
      })),
    });
  } catch (err) {
    console.error("Inventory chain error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inventory-trace/chain/sample/:sampleId
// Sample → PR, PO, DC, Inventory items it generated downstream
// ─────────────────────────────────────────────────────────────────────────────
router.get("/chain/sample/:sampleId", async (req, res) => {
  try {
    const { sampleId } = req.params;
    const sampleRes = await pool.query("SELECT * FROM samples WHERE sample_id=$1", [sampleId]);
    if (!sampleRes.rows.length) return res.status(404).json({ error: "Sample not found" });

    const [prs, pos, dcs, inv] = await Promise.all([
      pool.query(`SELECT pr.pr_id, pr.project_name, pr.workorder_no,
                         COUNT(pri.pr_item_id) AS item_count
                    FROM purchase_requisitions pr
                    LEFT JOIN purchase_requisition_items pri ON pri.pr_id=pr.pr_id
                   WHERE pr.sample_id=$1 GROUP BY pr.pr_id ORDER BY pr.created_at`, [sampleId]),
      pool.query("SELECT po_id,order_no,vendor_name,po_date,status FROM pos WHERE sample_id=$1 ORDER BY created_at", [sampleId]),
      pool.query(`SELECT dc.dc_id,dc.challan_number,dc.challan_date,dc.status,dc.inventory_synced
                    FROM delivery_challans dc JOIN pos po ON po.po_id=dc.po_id
                   WHERE po.sample_id=$1 ORDER BY dc.created_at`, [sampleId]),
      pool.query(`SELECT inventory_id,name,brand,units,current_quantity,source_dc_id
                    FROM inventories WHERE source_sample_id=$1 ORDER BY created_at`, [sampleId]),
    ]);

    res.json({
      sample: sampleRes.rows[0],
      downstream: {
        prs:               prs.rows,
        pos:               pos.rows,
        delivery_challans: dcs.rows,
        inventory_items:   inv.rows,
      },
      summary: {
        pr_count:        prs.rows.length,
        po_count:        pos.rows.length,
        dc_count:        dcs.rows.length,
        inventory_items: inv.rows.length,
        total_balance:   inv.rows.reduce((a, r) => a + Number(r.current_quantity), 0),
      },
    });
  } catch (err) {
    console.error("Sample chain error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inventory-trace/chain/pr/:prId
// PR items with inventory links + source chain per item
// ─────────────────────────────────────────────────────────────────────────────
router.get("/chain/pr/:prId", async (req, res) => {
  try {
    const { prId } = req.params;
    const prRes = await pool.query(
      `SELECT pr.*, s.building_name AS sample_building
         FROM purchase_requisitions pr
         LEFT JOIN samples s ON s.sample_id=pr.sample_id
        WHERE pr.pr_id=$1`, [prId]
    );
    if (!prRes.rows.length) return res.status(404).json({ error: "PR not found" });

    const items = await pool.query(
      `SELECT pri.*,
              i.name AS inv_name, i.brand AS inv_brand, i.units AS inv_units,
              i.current_quantity AS inv_balance,
              dc.challan_number, dc.challan_date,
              po.order_no AS po_number, po.vendor_name,
              s.building_name AS inv_sample_building
       FROM purchase_requisition_items pri
       LEFT JOIN inventories           i   ON i.inventory_id  =pri.inventory_id
       LEFT JOIN delivery_challans     dc  ON dc.dc_id        =i.source_dc_id
       LEFT JOIN pos                   po  ON po.po_id        =i.source_po_id
       LEFT JOIN samples               s   ON s.sample_id     =i.source_sample_id
       WHERE pri.pr_id=$1 ORDER BY pri.pr_item_id`, [prId]
    );

    const unlinked = items.rows.filter(r => !r.inventory_id).length;

    res.json({
      pr: prRes.rows[0],
      items_total:    items.rows.length,
      items_linked:   items.rows.length - unlinked,
      items_unlinked: unlinked,
      tip: unlinked ? `Call POST /api/inventory-trace/match/pr/${prId} to auto-link ${unlinked} item(s).` : null,
      items: items.rows.map(r => ({
        pr_item_id:           r.pr_item_id,
        material_description: r.material_description,
        req_qty:              r.req_qty,
        linked:               !!r.inventory_id,
        inventory: r.inventory_id ? {
          inventory_id: r.inventory_id,
          name:         r.inv_name,
          brand:        r.inv_brand,
          balance:      r.inv_balance,
          source_chain: buildChainLabel({ challan_number: r.challan_number, po_number: r.po_number, sample_building: r.inv_sample_building }),
        } : null,
      })),
    });
  } catch (err) {
    console.error("PR chain error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inventory-trace/chain/dc/:dcId
// DC → what inventory it created → where each item went
// ─────────────────────────────────────────────────────────────────────────────
router.get("/chain/dc/:dcId", async (req, res) => {
  try {
    const { dcId } = req.params;
    const dcRes = await pool.query("SELECT * FROM delivery_challans WHERE dc_id=$1", [dcId]);
    if (!dcRes.rows.length) return res.status(404).json({ error: "DC not found" });

    const chain  = await resolveUpstreamChain(dcId);
    const invRes = await pool.query(
      `SELECT i.inventory_id, i.name, i.brand, i.units, i.current_quantity,
              COALESCE(mv.total_in,  0) AS stocked_in,
              COALESCE(mv.total_out, 0) AS consumed
         FROM inventories i
         LEFT JOIN LATERAL (
           SELECT SUM(CASE WHEN movement_type='in'  THEN quantity ELSE 0 END) AS total_in,
                  SUM(CASE WHEN movement_type='out' THEN quantity ELSE 0 END) AS total_out
           FROM inventory_movements WHERE inventory_id=i.inventory_id
         ) mv ON TRUE
        WHERE i.source_dc_id=$1`, [dcId]
    );

    const items = await Promise.all(invRes.rows.map(async inv => {
      const usages = await pool.query(
        `SELECT m.movement_type, m.quantity, m.source_type, m.source_id, m.source_ref, m.created_at,
                s.building_name AS sample_name,
                pr.project_name AS pr_project,
                mir.mir_refrence_no AS mir_ref
           FROM inventory_movements m
           LEFT JOIN samples               s   ON m.source_type='sample' AND s.sample_id=m.source_id
           LEFT JOIN purchase_requisitions pr  ON m.source_type='pr'    AND pr.pr_id   =m.source_id
           LEFT JOIN mirs                  mir ON m.source_type='mir'   AND mir.mir_id =m.source_id
          WHERE m.inventory_id=$1 AND m.movement_type='out' ORDER BY m.created_at`,
        [inv.inventory_id]
      );
      return { ...inv, usages: usages.rows };
    }));

    res.json({
      dc: dcRes.rows[0],
      upstream_chain: chain,
      inventory_items_count: items.length,
      inventory_items: items,
    });
  } catch (err) {
    console.error("DC chain error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
module.exports.stampInventoryChain = stampInventoryChain;