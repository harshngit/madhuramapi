-- ============================================================
-- MIGRATION: Update source_id columns to TEXT to support alphanumeric sample_id
-- Date: 2026-06-03
-- ============================================================

-- Step 1: Drop the inventory_history_full view (since it depends on inventory_history.source_id)
DROP VIEW IF EXISTS inventory_history_full;

-- Step 2: Drop all foreign key constraints that reference samples.sample_id (since it's still INTEGER right now)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 
    FROM information_schema.table_constraints 
    WHERE constraint_name = 'inventories_source_sample_id_fkey'
  ) THEN
    ALTER TABLE inventories DROP CONSTRAINT inventories_source_sample_id_fkey;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 
    FROM information_schema.table_constraints 
    WHERE constraint_name = 'purchase_requisitions_sample_id_fkey'
  ) THEN
    ALTER TABLE purchase_requisitions DROP CONSTRAINT purchase_requisitions_sample_id_fkey;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 
    FROM information_schema.table_constraints 
    WHERE constraint_name = 'pos_sample_id_fkey'
  ) THEN
    ALTER TABLE pos DROP CONSTRAINT pos_sample_id_fkey;
  END IF;
END $$;

-- Step 3: Alter inventories.source_sample_id from INTEGER to TEXT
ALTER TABLE inventories ALTER COLUMN source_sample_id TYPE TEXT USING source_sample_id::TEXT;

-- Step 4: Alter inventory_movements.source_id from INTEGER to TEXT
ALTER TABLE inventory_movements ALTER COLUMN source_id TYPE TEXT USING source_id::TEXT;

-- Step 5: Alter inventory_history.source_id from INTEGER to TEXT
ALTER TABLE inventory_history ALTER COLUMN source_id TYPE TEXT USING source_id::TEXT;

-- Step 6: Alter pos.sample_id from INTEGER to TEXT
ALTER TABLE pos ALTER COLUMN sample_id TYPE TEXT USING sample_id::TEXT;

-- Step 7: Alter purchase_requisitions.sample_id from INTEGER to TEXT
ALTER TABLE purchase_requisitions ALTER COLUMN sample_id TYPE TEXT USING purchase_requisitions.sample_id::TEXT;

-- Step 8: Recreate foreign key constraints (now referencing TEXT sample_id)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM information_schema.table_constraints 
    WHERE constraint_name = 'inventories_source_sample_id_fkey'
  ) THEN
    ALTER TABLE inventories 
      ADD CONSTRAINT inventories_source_sample_id_fkey 
      FOREIGN KEY (source_sample_id) 
      REFERENCES samples(sample_id) 
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM information_schema.table_constraints 
    WHERE constraint_name = 'pos_sample_id_fkey'
  ) THEN
    ALTER TABLE pos 
      ADD CONSTRAINT pos_sample_id_fkey 
      FOREIGN KEY (sample_id) 
      REFERENCES samples(sample_id) 
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM information_schema.table_constraints 
    WHERE constraint_name = 'purchase_requisitions_sample_id_fkey'
  ) THEN
    ALTER TABLE purchase_requisitions 
      ADD CONSTRAINT purchase_requisitions_sample_id_fkey 
      FOREIGN KEY (sample_id) 
      REFERENCES samples(sample_id) 
      ON DELETE SET NULL;
  END IF;
END $$;

-- Step 9: Recreate the inventory_history_full view
CREATE OR REPLACE VIEW inventory_history_full AS
SELECT
    h.history_id,
    h.inventory_id,
    h.item_name,
    h.item_brand,
    h.item_units,
    h.change_type,
    h.stock_in,
    h.stock_out,
    h.balance_before,
    h.balance_after,
    (h.balance_after - h.balance_before) AS net_change,
    h.source_type,
    h.source_id,
    h.source_ref,
    h.project_id,
    h.project_name,
    h.notes,
    h.performed_by,
    h.performed_by_name,
    h.changed_fields,
    h.created_at,
    -- Resolve source document reference labels
    CASE h.source_type
      WHEN 'dc'     THEN 'Delivery Challan'
      WHEN 'po'     THEN 'Purchase Order'
      WHEN 'pr'     THEN 'Purchase Request'
      WHEN 'sample' THEN 'Sample'
      WHEN 'mir'    THEN 'MIR'
      WHEN 'manual' THEN 'Manual Entry'
      ELSE 'Unknown'
    END AS source_type_label,
    -- Human readable change type
    CASE h.change_type
      WHEN 'stock_in'   THEN 'Stock In'
      WHEN 'stock_out'  THEN 'Stock Out'
      WHEN 'adjustment' THEN 'Adjustment'
      WHEN 'created'    THEN 'Item Created'
      WHEN 'updated'    THEN 'Item Updated'
      WHEN 'deleted'    THEN 'Item Deleted'
      ELSE h.change_type
    END AS change_type_label
FROM inventory_history h;
