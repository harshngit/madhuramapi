-- ============================================================
-- INVENTORY HISTORY SCHEMA
-- File: inventory_history_schema.sql
-- Description: Creates the inventory_history table which logs
--              every inventory update with who did it,
--              stock-in, stock-out, and a running balance.
-- Run this once on your existing database (safe migrations).
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. CREATE inventory_history TABLE
--    Stores a full audit trail of inventory updates:
--    - who made the change (user_id, user_name)
--    - what item changed (inventory_id, item_name, brand)
--    - stock in / stock out quantities
--    - balance before and after
--    - source document reference
--    - notes and timestamps
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_history (
    history_id          SERIAL PRIMARY KEY,

    -- Which inventory item this log belongs to
    inventory_id        INTEGER NOT NULL
                          REFERENCES inventories(inventory_id)
                          ON DELETE CASCADE,

    -- Snapshot of item name & brand at time of change (denormalized for easy reads)
    item_name           TEXT,
    item_brand          TEXT,
    item_units          TEXT,

    -- Type of update
    -- 'stock_in'    → items added to inventory
    -- 'stock_out'   → items removed / consumed
    -- 'adjustment'  → manual correction
    -- 'created'     → initial inventory record created
    -- 'updated'     → metadata updated (price, name, etc.)
    change_type         TEXT NOT NULL
                          CHECK (change_type IN (
                            'stock_in', 'stock_out', 'adjustment',
                            'created', 'updated', 'deleted'
                          )),

    -- Stock-in quantity in this event (0 if it was a stock-out)
    stock_in            NUMERIC NOT NULL DEFAULT 0,

    -- Stock-out quantity in this event (0 if it was a stock-in)
    stock_out           NUMERIC NOT NULL DEFAULT 0,

    -- Balance snapshot before and after this change
    balance_before      NUMERIC NOT NULL DEFAULT 0,
    balance_after       NUMERIC NOT NULL DEFAULT 0,

    -- ── Source document traceability ─────────────────────────
    source_type         TEXT CHECK (source_type IN (
                          'dc', 'po', 'pr', 'sample', 'mir', 'manual'
                        )),
    source_id           INTEGER,        -- dc_id / po_id / pr_id / etc.
    source_ref          TEXT,           -- human-readable ref (challan_number, order_no, etc.)

    -- Project context
    project_id          INTEGER,
    project_name        TEXT,

    -- Notes / reason for change
    notes               TEXT,

    -- ── Who performed the change ──────────────────────────────
    performed_by        UUID,           -- user_id from your users table
    performed_by_name   TEXT,           -- snapshot of user name at time of change

    -- What fields changed (JSON diff for 'updated' type)
    changed_fields      JSONB,

    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ──────────────────────────────────────────────────────────────
-- 2. INDEXES for fast lookups
-- ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_inv_hist_inventory_id  ON inventory_history(inventory_id);
CREATE INDEX IF NOT EXISTS idx_inv_hist_change_type   ON inventory_history(change_type);
CREATE INDEX IF NOT EXISTS idx_inv_hist_performed_by  ON inventory_history(performed_by);
CREATE INDEX IF NOT EXISTS idx_inv_hist_project_id    ON inventory_history(project_id);
CREATE INDEX IF NOT EXISTS idx_inv_hist_source_type   ON inventory_history(source_type);
CREATE INDEX IF NOT EXISTS idx_inv_hist_created_at    ON inventory_history(created_at DESC);

COMMENT ON TABLE inventory_history IS
  'Full audit log of every inventory change: who updated it, stock-in, stock-out, and balance snapshots.';

-- ──────────────────────────────────────────────────────────────
-- 3. (OPTIONAL) TRIGGER — auto-populate inventory_history
--    from inventory_movements whenever a row is inserted there.
--    This keeps both tables in sync automatically.
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_sync_inventory_history()
RETURNS TRIGGER AS $$
DECLARE
  v_item          inventories%ROWTYPE;
  v_balance_before NUMERIC;
  v_change_type   TEXT;
BEGIN
  -- Fetch current item snapshot
  SELECT * INTO v_item FROM inventories WHERE inventory_id = NEW.inventory_id;

  -- Balance before = balance_after - signed quantity
  IF NEW.movement_type = 'in' THEN
    v_balance_before := NEW.balance_after - NEW.quantity;
    v_change_type    := 'stock_in';
  ELSIF NEW.movement_type = 'out' THEN
    v_balance_before := NEW.balance_after + NEW.quantity;
    v_change_type    := 'stock_out';
  ELSE
    v_balance_before := NEW.balance_after;   -- adjustment: hard to know before
    v_change_type    := 'adjustment';
  END IF;

  INSERT INTO inventory_history (
    inventory_id,
    item_name, item_brand, item_units,
    change_type,
    stock_in, stock_out,
    balance_before, balance_after,
    source_type, source_id, source_ref,
    project_id, project_name,
    notes,
    performed_by, performed_by_name,
    created_at
  ) VALUES (
    NEW.inventory_id,
    v_item.name, v_item.brand, v_item.units,
    v_change_type,
    CASE WHEN NEW.movement_type = 'in'         THEN NEW.quantity ELSE 0 END,
    CASE WHEN NEW.movement_type = 'out'        THEN NEW.quantity ELSE 0 END,
    v_balance_before,
    NEW.balance_after,
    NEW.source_type, NEW.source_id, NEW.source_ref,
    NEW.project_id, NEW.project_name,
    NEW.notes,
    NEW.performed_by, NEW.performed_by_name,
    NEW.created_at
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach trigger to inventory_movements
DROP TRIGGER IF EXISTS trg_sync_inventory_history ON inventory_movements;
CREATE TRIGGER trg_sync_inventory_history
  AFTER INSERT ON inventory_movements
  FOR EACH ROW
  EXECUTE FUNCTION fn_sync_inventory_history();

-- ──────────────────────────────────────────────────────────────
-- 4. HELPFUL VIEW — inventory_history_full
--    Joins history with users table for richer display.
-- ──────────────────────────────────────────────────────────────
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

COMMENT ON VIEW inventory_history_full IS
  'Enriched view of inventory_history with readable labels for source type and change type.';
