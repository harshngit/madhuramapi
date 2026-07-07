-- Track quantity consumed by samples against each BOQ item
ALTER TABLE boqs
ADD COLUMN IF NOT EXISTS used_quantity NUMERIC DEFAULT 0;

-- Speed up reverse lookup: "which samples used this BOQ item"
-- (samples.item_description is a JSONB array; each element may carry a boq_id)
CREATE INDEX IF NOT EXISTS idx_samples_item_description_gin
  ON samples USING GIN (item_description);
