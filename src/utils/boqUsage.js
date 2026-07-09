const { pool } = require("../db");

// ─────────────────────────────────────────────────────────────────────────────
// Cross-entity BOQ usage lookups. Informational only — none of PR/PO/ITR/DC
// deduct from boqs.used_quantity; only samples does (see src/routes/sample.js).
//
// Linkage shape per entity:
//   samples                : item_description[]        item.boq_id, item.boq_issued_qty
//   purchase_requisition_items (real table): boq_id, boq_qty columns
//   pos                     : items[]                   item.boq_id, item.boq_qty
//   itrs                    : work_items[]               item.boq_id, item.boq_qty
//   delivery_challans       : items[]                   item.boq_id, item.boq_qty
// ─────────────────────────────────────────────────────────────────────────────

// Batched counts for many boq_ids at once — used to annotate a list of items
// (e.g. a sample's item_description) with each item's total system-wide usage.
// Returns { [boq_id]: { samples, pr, po, itr, dc, total } }
async function getBoqUsageCounts(boqIds) {
  const ids = [...new Set((boqIds || []).map(Number).filter(Boolean))];
  const out = {};
  for (const id of ids) out[id] = { samples: 0, pr: 0, po: 0, itr: 0, dc: 0, total: 0 };
  if (ids.length === 0) return out;

  const idsText = ids.map(String);

  const [samplesRes, prRes, poRes, itrRes, dcRes] = await Promise.all([
    pool.query(
      `SELECT elem->>'boq_id' AS boq_id, COUNT(*) AS cnt
         FROM samples, jsonb_array_elements(item_description) elem
        WHERE elem->>'boq_id' = ANY($1::text[])
        GROUP BY 1`,
      [idsText]
    ),
    pool.query(
      `SELECT boq_id, COUNT(*) AS cnt
         FROM purchase_requisition_items
        WHERE boq_id = ANY($1)
        GROUP BY 1`,
      [ids]
    ),
    pool.query(
      `SELECT elem->>'boq_id' AS boq_id, COUNT(*) AS cnt
         FROM pos, jsonb_array_elements(items) elem
        WHERE elem->>'boq_id' = ANY($1::text[])
        GROUP BY 1`,
      [idsText]
    ),
    pool.query(
      `SELECT elem->>'boq_id' AS boq_id, COUNT(*) AS cnt
         FROM itrs, jsonb_array_elements(work_items) elem
        WHERE elem->>'boq_id' = ANY($1::text[])
        GROUP BY 1`,
      [idsText]
    ),
    pool.query(
      `SELECT elem->>'boq_id' AS boq_id, COUNT(*) AS cnt
         FROM delivery_challans, jsonb_array_elements(items) elem
        WHERE elem->>'boq_id' = ANY($1::text[])
        GROUP BY 1`,
      [idsText]
    ),
  ]);

  const apply = (rows, key) => rows.forEach(r => {
    if (out[r.boq_id]) out[r.boq_id][key] = Number(r.cnt);
  });
  apply(samplesRes.rows, "samples");
  apply(prRes.rows, "pr");
  apply(poRes.rows, "po");
  apply(itrRes.rows, "itr");
  apply(dcRes.rows, "dc");

  for (const id of ids) {
    const u = out[id];
    u.total = u.samples + u.pr + u.po + u.itr + u.dc;
  }
  return out;
}

// Full detail lists for ONE boq_id — used by GET /api/boq/:id.
async function getBoqUsageDetails(boqId) {
  const boqIdText = String(boqId);
  const [samplesRes, prRes, poRes, itrRes, dcRes] = await Promise.all([
    pool.query(
      `SELECT s.sample_id, s.building_name, s.site_name, s.project_id,
              NULLIF(elem->>'boq_issued_qty', '')::numeric AS qty
         FROM samples s, jsonb_array_elements(s.item_description) elem
        WHERE elem->>'boq_id' = $1`,
      [boqIdText]
    ),
    pool.query(
      `SELECT pri.pr_id, pr.pr_number, pri.material_description, pri.boq_qty AS qty, pr.project_id
         FROM purchase_requisition_items pri
         JOIN purchase_requisitions pr ON pr.pr_id = pri.pr_id
        WHERE pri.boq_id = $1`,
      [boqId]
    ),
    pool.query(
      `SELECT p.po_id, p.order_no, p.project_id,
              NULLIF(elem->>'boq_qty', '')::numeric AS qty
         FROM pos p, jsonb_array_elements(p.items) elem
        WHERE elem->>'boq_id' = $1`,
      [boqIdText]
    ),
    pool.query(
      `SELECT i.itr_id, i.itr_ref_no, i.project_id,
              NULLIF(elem->>'boq_qty', '')::numeric AS qty
         FROM itrs i, jsonb_array_elements(i.work_items) elem
        WHERE elem->>'boq_id' = $1`,
      [boqIdText]
    ),
    pool.query(
      `SELECT d.dc_id, d.challan_number, d.project_id,
              NULLIF(elem->>'boq_qty', '')::numeric AS qty
         FROM delivery_challans d, jsonb_array_elements(d.items) elem
        WHERE elem->>'boq_id' = $1`,
      [boqIdText]
    ),
  ]);

  return {
    used_in_samples: samplesRes.rows,
    used_in_pr:       prRes.rows,
    used_in_po:       poRes.rows,
    used_in_itr:      itrRes.rows,
    used_in_dc:       dcRes.rows,
    usage_counts: {
      samples: samplesRes.rowCount,
      pr:      prRes.rowCount,
      po:      poRes.rowCount,
      itr:     itrRes.rowCount,
      dc:      dcRes.rowCount,
      total:   samplesRes.rowCount + prRes.rowCount + poRes.rowCount + itrRes.rowCount + dcRes.rowCount,
    },
  };
}

module.exports = { getBoqUsageCounts, getBoqUsageDetails };
