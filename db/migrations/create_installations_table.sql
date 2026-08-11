-- ─────────────────────────────────────────────────────────────────────────────
-- New module: Installations
-- Mirrors the `samples` table shape (installation_id is a frontend-supplied
-- unique text identifier, same as sample_id), so item_description items can
-- carry inventory_id/issued_qty and boq_id/boq_issued_qty for the same
-- auto stock-out / BOQ consumption behavior as Sample.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS installations (
    id                SERIAL PRIMARY KEY,
    installation_id   TEXT UNIQUE NOT NULL,
    project_id        INTEGER REFERENCES projects(project_id) ON DELETE CASCADE,
    flats             TEXT,
    building_name     TEXT,
    site_name         TEXT,
    location          JSONB DEFAULT '{}'::jsonb, -- { floor, flat_no, block, wing, coordinates }
    work_done         TEXT,
    item_description  JSONB DEFAULT '[]'::jsonb, -- Array of { sr_no, item_name, item_code, item_no, brand_name, description, specification, unit, quantity, value, inventory_id, issued_qty, boq_id, boq_issued_qty }
    add_fields        JSONB DEFAULT '[]'::jsonb,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_installations_project_id ON installations(project_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Widen inventory_movements.source_type and inventory_history.source_type to
-- also allow 'installation', so recordMovement()/logInventoryHistory() calls
-- from the new installation module pass their CHECK constraints. Constraint
-- names are looked up dynamically instead of hardcoded, since they may have
-- been auto-named differently depending on when the table was first created.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  con RECORD;
BEGIN
  FOR con IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
     WHERE rel.relname = 'inventory_movements'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%source_type%'
  LOOP
    EXECUTE format('ALTER TABLE inventory_movements DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_source_type_check
  CHECK (source_type IN ('dc', 'po', 'pr', 'sample', 'manual', 'mir', 'installation'));

DO $$
DECLARE
  con RECORD;
BEGIN
  FOR con IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
     WHERE rel.relname = 'inventory_history'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%source_type%'
  LOOP
    EXECUTE format('ALTER TABLE inventory_history DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

ALTER TABLE inventory_history
  ADD CONSTRAINT inventory_history_source_type_check
  CHECK (source_type IN ('dc', 'po', 'pr', 'sample', 'mir', 'manual', 'installation'));

-- ─────────────────────────────────────────────────────────────────────────────
-- Add the 'installation' label to inventory_history_full's source_type_label
-- ─────────────────────────────────────────────────────────────────────────────
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
    CASE h.source_type
      WHEN 'dc'           THEN 'Delivery Challan'
      WHEN 'po'           THEN 'Purchase Order'
      WHEN 'pr'           THEN 'Purchase Request'
      WHEN 'sample'       THEN 'Sample'
      WHEN 'mir'          THEN 'MIR'
      WHEN 'manual'       THEN 'Manual Entry'
      WHEN 'installation' THEN 'Installation'
      ELSE 'Unknown'
    END AS source_type_label,
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
