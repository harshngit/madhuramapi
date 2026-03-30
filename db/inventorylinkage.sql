-- ============================================================
-- INVENTORY LINKAGE: Add inventory_id to consuming documents
-- File: db_inventory_linkage.sql
-- Run AFTER db_new_tables.sql and db_update_existing.sql
-- All statements are safe / idempotent (IF NOT EXISTS / DO blocks)
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. purchase_requisition_items
--    Each PR line item can now point to the exact inventory item
--    it will consume (fulfilled from stock).
-- ──────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'purchase_requisition_items'
      AND column_name = 'inventory_id'
  ) THEN
    ALTER TABLE purchase_requisition_items
      ADD COLUMN inventory_id INTEGER REFERENCES inventories(inventory_id) ON DELETE SET NULL;
  END IF;
END $$;

-- Track whether this PR item has actually been issued from inventory
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'purchase_requisition_items'
      AND column_name = 'issued_from_inventory'
  ) THEN
    ALTER TABLE purchase_requisition_items
      ADD COLUMN issued_from_inventory BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'purchase_requisition_items'
      AND column_name = 'issued_qty'
  ) THEN
    ALTER TABLE purchase_requisition_items
      ADD COLUMN issued_qty NUMERIC DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'purchase_requisition_items'
      AND column_name = 'issued_at'
  ) THEN
    ALTER TABLE purchase_requisition_items
      ADD COLUMN issued_at TIMESTAMP;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pri_inventory_id
  ON purchase_requisition_items(inventory_id);


-- ──────────────────────────────────────────────────────────────
-- 2. mirs
--    MIR (Material Inspection Report) links to inventory items
--    it inspects / consumes.
--    We store the linked inventory ids as a JSONB array because
--    a single MIR can cover multiple inventory items.
-- ──────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'mirs' AND column_name = 'inventory_items'
  ) THEN
    -- Array of { inventory_id, quantity, notes }
    ALTER TABLE mirs ADD COLUMN inventory_items JSONB DEFAULT '[]'::jsonb;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'mirs' AND column_name = 'inventory_synced'
  ) THEN
    ALTER TABLE mirs ADD COLUMN inventory_synced BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'mirs' AND column_name = 'inventory_synced_at'
  ) THEN
    ALTER TABLE mirs ADD COLUMN inventory_synced_at TIMESTAMP;
  END IF;
END $$;


-- ──────────────────────────────────────────────────────────────
-- 3. samples
--    sample.item_description is already a JSONB array.
--    We add a top-level inventory_items column (same pattern as MIR)
--    so each sample can declare which inventory items it consumed.
-- ──────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'samples' AND column_name = 'inventory_items'
  ) THEN
    -- Array of { inventory_id, quantity, notes }
    ALTER TABLE samples ADD COLUMN inventory_items JSONB DEFAULT '[]'::jsonb;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'samples' AND column_name = 'inventory_synced'
  ) THEN
    ALTER TABLE samples ADD COLUMN inventory_synced BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'samples' AND column_name = 'inventory_synced_at'
  ) THEN
    ALTER TABLE samples ADD COLUMN inventory_synced_at TIMESTAMP;
  END IF;
END $$;


-- ──────────────────────────────────────────────────────────────
-- 4. Helpful indexes
-- ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_mirs_inventory_synced
  ON mirs(inventory_synced);

CREATE INDEX IF NOT EXISTS idx_samples_inventory_synced
  ON samples(inventory_synced);