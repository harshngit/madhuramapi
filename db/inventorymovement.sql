-- ============================================================
-- NEW TABLES: Inventory Movement History
-- File: db_new_tables.sql
-- Run this on a fresh setup or first-time migration
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. inventory_movements
--    Tracks every stock-in / stock-out / adjustment event
--    for an inventory item, with full source traceability.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_movements (
    movement_id     SERIAL PRIMARY KEY,

    -- Which inventory item moved
    inventory_id    INTEGER NOT NULL
                      REFERENCES inventories(inventory_id)
                      ON DELETE CASCADE,

    -- Direction: 'in' = stock received, 'out' = dispatched / consumed
    movement_type   TEXT NOT NULL CHECK (movement_type IN ('in', 'out', 'adjustment')),

    -- How many units moved in this event
    quantity        NUMERIC NOT NULL,

    -- Snapshot of balance AFTER this movement
    balance_after   NUMERIC NOT NULL,

    -- ── Source traceability ──────────────────────────────────
    -- Which document triggered this movement (only one filled at a time)
    source_type     TEXT CHECK (source_type IN ('dc', 'po', 'pr', 'sample', 'manual', 'mir')),
    source_id       INTEGER,        -- FK value (dc_id / po_id / pr_id / sample_id / mir_id)
    source_ref      TEXT,           -- Human-readable ref number (challan_number / order_no / pr_no etc.)

    -- Which project this movement is linked to
    project_id      INTEGER,
    project_name    TEXT,

    -- Notes / reason for manual adjustments
    notes           TEXT,

    -- Who performed
    performed_by      UUID,
    performed_by_name TEXT,

    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_inv_mov_inventory_id  ON inventory_movements(inventory_id);
CREATE INDEX IF NOT EXISTS idx_inv_mov_source_type   ON inventory_movements(source_type);
CREATE INDEX IF NOT EXISTS idx_inv_mov_source_id     ON inventory_movements(source_id);
CREATE INDEX IF NOT EXISTS idx_inv_mov_project_id    ON inventory_movements(project_id);
CREATE INDEX IF NOT EXISTS idx_inv_mov_created_at    ON inventory_movements(created_at DESC);

COMMENT ON TABLE inventory_movements IS
  'Full audit trail of every quantity change for each inventory item.';