-- Add sample_id to mirs (link a MIR to a sample)

ALTER TABLE mirs
ADD COLUMN IF NOT EXISTS sample_id TEXT REFERENCES samples(sample_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_mirs_sample_id ON mirs(sample_id);
