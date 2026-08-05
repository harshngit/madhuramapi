-- Add sample_id to delivery_challans (link a DC to a sample)

ALTER TABLE delivery_challans
ADD COLUMN IF NOT EXISTS sample_id TEXT REFERENCES samples(sample_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_delivery_challans_sample_id ON delivery_challans(sample_id);
