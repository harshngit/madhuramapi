-- ============================================================
-- INVENTORY CHAIN TRACEABILITY COLUMNS
-- File: db_inventory_chain_columns.sql
-- Run this once on your existing database.
-- All statements are safe / idempotent (DO $$ blocks).
-- ============================================================

-- inventories: store the full document chain that created each item
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='inventories' AND column_name='source_sample_id') THEN
    ALTER TABLE inventories ADD COLUMN source_sample_id INTEGER REFERENCES samples(sample_id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='inventories' AND column_name='source_pr_id') THEN
    ALTER TABLE inventories ADD COLUMN source_pr_id INTEGER REFERENCES purchase_requisitions(pr_id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='inventories' AND column_name='source_po_id') THEN
    ALTER TABLE inventories ADD COLUMN source_po_id INTEGER REFERENCES pos(po_id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='inventories' AND column_name='source_dc_id') THEN
    ALTER TABLE inventories ADD COLUMN source_dc_id INTEGER REFERENCES delivery_challans(dc_id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='inventories' AND column_name='current_quantity') THEN
    ALTER TABLE inventories ADD COLUMN current_quantity NUMERIC DEFAULT 0;
    UPDATE inventories SET current_quantity = COALESCE(quantity, 0);
  END IF;
END $$;

-- purchase_requisition_items: add inventory_id link + issue tracking
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='purchase_requisition_items' AND column_name='inventory_id') THEN
    ALTER TABLE purchase_requisition_items
      ADD COLUMN inventory_id INTEGER REFERENCES inventories(inventory_id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='purchase_requisition_items' AND column_name='issued_qty') THEN
    ALTER TABLE purchase_requisition_items ADD COLUMN issued_qty NUMERIC DEFAULT 0;
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

-- delivery_challans: track if inventory sync has been done
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='delivery_challans' AND column_name='inventory_synced') THEN
    ALTER TABLE delivery_challans ADD COLUMN inventory_synced BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='delivery_challans' AND column_name='inventory_synced_at') THEN
    ALTER TABLE delivery_challans ADD COLUMN inventory_synced_at TIMESTAMP;
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_inventories_source_dc_id     ON inventories(source_dc_id);
CREATE INDEX IF NOT EXISTS idx_inventories_source_po_id     ON inventories(source_po_id);
CREATE INDEX IF NOT EXISTS idx_inventories_source_pr_id     ON inventories(source_pr_id);
CREATE INDEX IF NOT EXISTS idx_inventories_source_sample_id ON inventories(source_sample_id);
CREATE INDEX IF NOT EXISTS idx_inventories_project_id       ON inventories(project_id);
CREATE INDEX IF NOT EXISTS idx_pri_inventory_id             ON purchase_requisition_items(inventory_id);
CREATE INDEX IF NOT EXISTS idx_dc_inventory_synced          ON delivery_challans(inventory_synced);

-- Full-text search index on item name
CREATE INDEX IF NOT EXISTS idx_inventories_name_trgm
  ON inventories USING gin(to_tsvector('english', COALESCE(name, '')));
