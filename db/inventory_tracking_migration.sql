-- ============================================================
-- INVENTORY TRACKING MIGRATION
-- File: inventory_tracking_migration.sql
-- Purpose: Adds missing columns and indexes to support full
--          inventory search + history tracking across PR, Sample,
--          PO, DC, and MIR documents.
--
-- Run this ONCE on your existing database. All statements use
-- IF NOT EXISTS / DO $$ blocks so it is safe to re-run.
-- ============================================================

-- ── 1. inventories — add chain source columns if missing ────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='inventories' AND column_name='current_quantity') THEN
    ALTER TABLE inventories ADD COLUMN current_quantity NUMERIC DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='inventories' AND column_name='source_dc_id') THEN
    ALTER TABLE inventories ADD COLUMN source_dc_id INTEGER;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='inventories' AND column_name='source_po_id') THEN
    ALTER TABLE inventories ADD COLUMN source_po_id INTEGER;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='inventories' AND column_name='source_pr_id') THEN
    ALTER TABLE inventories ADD COLUMN source_pr_id INTEGER;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='inventories' AND column_name='source_sample_id') THEN
    ALTER TABLE inventories ADD COLUMN source_sample_id INTEGER;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='inventories' AND column_name='project_id') THEN
    ALTER TABLE inventories ADD COLUMN project_id INTEGER;
  END IF;
END $$;

-- ── 2. purchase_requisition_items — add inventory link columns ──────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='purchase_requisition_items' AND column_name='inventory_id') THEN
    ALTER TABLE purchase_requisition_items ADD COLUMN inventory_id INTEGER;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='purchase_requisition_items' AND column_name='issued_qty') THEN
    ALTER TABLE purchase_requisition_items ADD COLUMN issued_qty NUMERIC;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='purchase_requisition_items' AND column_name='issued_from_inventory') THEN
    ALTER TABLE purchase_requisition_items ADD COLUMN issued_from_inventory BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='purchase_requisition_items' AND column_name='issued_at') THEN
    ALTER TABLE purchase_requisition_items ADD COLUMN issued_at TIMESTAMP;
  END IF;
END $$;

-- ── 3. inventory_movements — ensure all columns exist ───────────────────────
CREATE TABLE IF NOT EXISTS inventory_movements (
    movement_id       SERIAL PRIMARY KEY,
    inventory_id      INTEGER NOT NULL REFERENCES inventories(inventory_id) ON DELETE CASCADE,
    movement_type     TEXT NOT NULL CHECK (movement_type IN ('in', 'out', 'adjustment')),
    quantity          NUMERIC NOT NULL,
    balance_after     NUMERIC NOT NULL,
    source_type       TEXT CHECK (source_type IN ('dc', 'po', 'pr', 'sample', 'manual', 'mir')),
    source_id         INTEGER,
    source_ref        TEXT,
    project_id        INTEGER,
    project_name      TEXT,
    notes             TEXT,
    performed_by      UUID,
    performed_by_name TEXT,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── 4. inventory_history — ensure table exists ──────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_history (
    history_id        SERIAL PRIMARY KEY,
    inventory_id      INTEGER NOT NULL REFERENCES inventories(inventory_id) ON DELETE CASCADE,
    item_name         TEXT,
    item_brand        TEXT,
    item_units        TEXT,
    change_type       TEXT NOT NULL CHECK (change_type IN (
                        'stock_in','stock_out','adjustment','created','updated','deleted'
                      )),
    stock_in          NUMERIC NOT NULL DEFAULT 0,
    stock_out         NUMERIC NOT NULL DEFAULT 0,
    balance_before    NUMERIC NOT NULL DEFAULT 0,
    balance_after     NUMERIC NOT NULL DEFAULT 0,
    source_type       TEXT CHECK (source_type IN ('dc','po','pr','sample','mir','manual')),
    source_id         INTEGER,
    source_ref        TEXT,
    project_id        INTEGER,
    project_name      TEXT,
    notes             TEXT,
    performed_by      UUID,
    performed_by_name TEXT,
    changed_fields    JSONB,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── 5. Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_inventories_name        ON inventories USING gin(to_tsvector('english', COALESCE(name,'')));
CREATE INDEX IF NOT EXISTS idx_inventories_name_trgm   ON inventories(name);
CREATE INDEX IF NOT EXISTS idx_inventories_project_id  ON inventories(project_id);
CREATE INDEX IF NOT EXISTS idx_inventories_source_dc   ON inventories(source_dc_id);
CREATE INDEX IF NOT EXISTS idx_inventories_source_po   ON inventories(source_po_id);
CREATE INDEX IF NOT EXISTS idx_inventories_source_pr   ON inventories(source_pr_id);
CREATE INDEX IF NOT EXISTS idx_inventories_source_smp  ON inventories(source_sample_id);

CREATE INDEX IF NOT EXISTS idx_inv_mov_inventory_id    ON inventory_movements(inventory_id);
CREATE INDEX IF NOT EXISTS idx_inv_mov_source_type     ON inventory_movements(source_type);
CREATE INDEX IF NOT EXISTS idx_inv_mov_source_id       ON inventory_movements(source_id);
CREATE INDEX IF NOT EXISTS idx_inv_mov_project_id      ON inventory_movements(project_id);
CREATE INDEX IF NOT EXISTS idx_inv_mov_created_at      ON inventory_movements(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inv_hist_inventory_id   ON inventory_history(inventory_id);
CREATE INDEX IF NOT EXISTS idx_inv_hist_change_type    ON inventory_history(change_type);
CREATE INDEX IF NOT EXISTS idx_inv_hist_performed_by   ON inventory_history(performed_by);
CREATE INDEX IF NOT EXISTS idx_inv_hist_project_id     ON inventory_history(project_id);
CREATE INDEX IF NOT EXISTS idx_inv_hist_source_type    ON inventory_history(source_type);
CREATE INDEX IF NOT EXISTS idx_inv_hist_created_at     ON inventory_history(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pri_inventory_id        ON purchase_requisition_items(inventory_id);

-- ── 6. Enriched view: inventory_full_history ─────────────────────────────────
-- This view joins inventory_history with all source document tables
-- so you get human-readable source names (challan number, PR number, etc.)
-- without extra queries.
CREATE OR REPLACE VIEW inventory_full_history AS
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
    -- Resolved source document details
    dc.challan_number                       AS dc_challan_number,
    dc.challan_date                         AS dc_challan_date,
    po.order_no                             AS po_order_no,
    po.vendor_name                          AS po_vendor_name,
    pr.pr_id                                AS pr_number,
    pr.location                             AS pr_location,
    pris.material_description               AS pr_item_name,
    s.building_name                         AS sample_building,
    s.site_name                             AS sample_site,
    mir.mir_refrence_no                     AS mir_ref_no,
    h.project_id,
    h.project_name,
    h.notes,
    h.performed_by,
    h.performed_by_name,
    h.changed_fields,
    h.created_at
FROM inventory_history h
LEFT JOIN delivery_challans dc
       ON h.source_type = 'dc'     AND dc.dc_id      = h.source_id
LEFT JOIN pos po
       ON h.source_type = 'po'     AND po.po_id       = h.source_id
LEFT JOIN purchase_requisitions pr
       ON h.source_type = 'pr'     AND pr.pr_id       = h.source_id
LEFT JOIN purchase_requisition_items pris
       ON h.source_type = 'pr'     AND pris.pr_id     = h.source_id
                                   AND pris.inventory_id = h.inventory_id
LEFT JOIN samples s
       ON h.source_type = 'sample' AND s.sample_id    = h.source_id
LEFT JOIN mirs mir
       ON h.source_type = 'mir'    AND mir.mir_id     = h.source_id;

COMMENT ON VIEW inventory_full_history IS
  'Enriched inventory history: resolves DC challan number, PO order no, PR number, Sample building, and MIR reference for every history event.';
