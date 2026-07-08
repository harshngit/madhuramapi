-- BOQ usage tracking: PR, PO, ITR, DC
-- (informational linkage only — does NOT affect boqs.used_quantity/remaining_quantity,
--  which stays driven by samples alone; see db/migrations/add_used_quantity_to_boq.sql)

-- PR items are a real table, so boq_id is a real FK column + qty column.
-- PO/ITR/DC store items as JSONB arrays (pos.items, itrs.work_items,
-- delivery_challans.items) — clients simply include a "boq_id" (and
-- optionally "boq_qty") key inside each item object; no column needed there,
-- but a GIN index makes the reverse "which PO/ITR/DC used this BOQ item"
-- lookup fast.

ALTER TABLE purchase_requisition_items
ADD COLUMN IF NOT EXISTS boq_id INTEGER REFERENCES boqs(boq_id);

ALTER TABLE purchase_requisition_items
ADD COLUMN IF NOT EXISTS boq_qty NUMERIC;

CREATE INDEX IF NOT EXISTS idx_pr_items_boq_id
  ON purchase_requisition_items(boq_id);

CREATE INDEX IF NOT EXISTS idx_pos_items_gin
  ON pos USING GIN (items);

CREATE INDEX IF NOT EXISTS idx_itrs_work_items_gin
  ON itrs USING GIN (work_items);

CREATE INDEX IF NOT EXISTS idx_delivery_challans_items_gin
  ON delivery_challans USING GIN (items);
