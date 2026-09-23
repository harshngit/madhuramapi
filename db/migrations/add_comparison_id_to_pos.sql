-- Link a PO back to the vendor comparison it was created from
ALTER TABLE pos
ADD COLUMN IF NOT EXISTS comparison_id INTEGER REFERENCES vendor_comparisons(comparison_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pos_comparison_id ON pos(comparison_id);
