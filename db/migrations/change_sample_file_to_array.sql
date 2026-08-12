-- ─────────────────────────────────────────────────────────────────────────────
-- Change samples.sample_file from a single TEXT path to a JSONB array of paths,
-- matching what POST /api/sample/upload already returns (filePaths[]).
-- Existing single-file values are preserved by wrapping them in a 1-element array.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE samples ADD COLUMN IF NOT EXISTS sample_file_new JSONB DEFAULT '[]'::jsonb;

UPDATE samples
SET sample_file_new = CASE
  WHEN sample_file IS NULL OR sample_file = '' THEN '[]'::jsonb
  ELSE jsonb_build_array(sample_file)
END
WHERE sample_file_new = '[]'::jsonb;

ALTER TABLE samples DROP COLUMN IF EXISTS sample_file;
ALTER TABLE samples RENAME COLUMN sample_file_new TO sample_file;
