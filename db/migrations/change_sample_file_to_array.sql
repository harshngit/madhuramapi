-- ─────────────────────────────────────────────────────────────────────────────
-- Change samples.sample_file from a single TEXT path to a JSONB array of paths,
-- matching what POST /api/sample/upload already returns (filePaths[]).
-- Existing single-file values are preserved by wrapping them in a 1-element array.
--
-- Idempotent / safe to re-run: checks the column's CURRENT type first and
-- skips the conversion entirely if sample_file is already json/jsonb (running
-- the old version of this script a second time failed with
-- "invalid input syntax for type json" because it compared an already-jsonb
-- column to the text literal '' — Postgres tried to cast '' to jsonb to make
-- that comparison and an empty string isn't valid JSON).
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  col_type text;
BEGIN
  SELECT data_type INTO col_type
    FROM information_schema.columns
   WHERE table_name = 'samples' AND column_name = 'sample_file';

  IF col_type IS NULL THEN
    RAISE NOTICE 'samples.sample_file does not exist — skipping';
  ELSIF col_type IN ('json', 'jsonb') THEN
    RAISE NOTICE 'samples.sample_file is already %, skipping conversion', col_type;
  ELSE
    ALTER TABLE samples ADD COLUMN IF NOT EXISTS sample_file_new JSONB DEFAULT '[]'::jsonb;

    UPDATE samples
       SET sample_file_new = CASE
         WHEN sample_file IS NULL OR sample_file = '' THEN '[]'::jsonb
         ELSE jsonb_build_array(sample_file)
       END;

    ALTER TABLE samples DROP COLUMN sample_file;
    ALTER TABLE samples RENAME COLUMN sample_file_new TO sample_file;
  END IF;
END $$;
