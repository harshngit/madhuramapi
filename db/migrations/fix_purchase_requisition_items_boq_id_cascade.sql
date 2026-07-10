-- ─────────────────────────────────────────────────────────────────────────────
-- Fix: purchase_requisition_items.boq_id had no ON DELETE action, so deleting
-- a BOQ item (e.g. via a project delete cascading into boqs) failed with:
--   "update or delete on table "boqs" violates foreign key constraint
--    purchase_requisition_items_boq_id_fkey"
-- boq_id here is informational only (doesn't drive any business logic — see
-- add_boq_usage_tracking_to_pr_po_itr_dc.sql), so SET NULL matches the
-- sibling inventory_id_fkey on this same table.
-- Date: 2026-07-10
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE purchase_requisition_items
DROP CONSTRAINT IF EXISTS purchase_requisition_items_boq_id_fkey;

ALTER TABLE purchase_requisition_items
ADD CONSTRAINT purchase_requisition_items_boq_id_fkey
FOREIGN KEY (boq_id) REFERENCES boqs(boq_id) ON DELETE SET NULL;
