-- ============================================================
-- UPDATE QUERIES: Alter existing tables for inventory history
-- File: db_update_existing.sql
-- Run this on an existing database (safe, uses IF NOT EXISTS / DO blocks)
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. inventories table
--    Add a running `current_quantity` column that always reflects
--    the live balance (updated by triggers / application).
--    Also add project_id linkage and a `source_dc_id` for the
--    last DC that stocked this item in.
-- ──────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inventories' AND column_name = 'current_quantity'
  ) THEN
    ALTER TABLE inventories ADD COLUMN current_quantity NUMERIC DEFAULT 0;
    -- Seed current_quantity from existing quantity column
    UPDATE inventories SET current_quantity = COALESCE(quantity, 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inventories' AND column_name = 'project_id'
  ) THEN
    ALTER TABLE inventories ADD COLUMN project_id INTEGER;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inventories' AND column_name = 'source_dc_id'
  ) THEN
    ALTER TABLE inventories ADD COLUMN source_dc_id INTEGER;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inventories' AND column_name = 'source_po_id'
  ) THEN
    ALTER TABLE inventories ADD COLUMN source_po_id INTEGER;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inventories' AND column_name = 'source_pr_id'
  ) THEN
    ALTER TABLE inventories ADD COLUMN source_pr_id INTEGER;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inventories' AND column_name = 'source_sample_id'
  ) THEN
    ALTER TABLE inventories ADD COLUMN source_sample_id INTEGER;
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────
-- 2. delivery_challans table
--    Add a flag so we know whether DC items have been pushed
--    into inventory already (prevents double-stocking).
-- ──────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'delivery_challans' AND column_name = 'inventory_synced'
  ) THEN
    ALTER TABLE delivery_challans ADD COLUMN inventory_synced BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'delivery_challans' AND column_name = 'inventory_synced_at'
  ) THEN
    ALTER TABLE delivery_challans ADD COLUMN inventory_synced_at TIMESTAMP;
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────
-- 3. Indexes on existing tables that help history queries
-- ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_inventories_project_id   ON inventories(project_id);
CREATE INDEX IF NOT EXISTS idx_inventories_source_dc_id ON inventories(source_dc_id);
CREATE INDEX IF NOT EXISTS idx_inventories_name         ON inventories USING GIN (to_tsvector('english', COALESCE(name,'')));
CREATE INDEX IF NOT EXISTS idx_dc_inventory_synced      ON delivery_challans(inventory_synced);