-- Add sample_id to installations, linking an installation back to the sample
-- it came from (same pattern as delivery_challans.sample_id, mirs.sample_id,
-- pos.sample_id, purchase_requisitions.sample_id).

ALTER TABLE installations
ADD COLUMN IF NOT EXISTS sample_id TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'installations_sample_id_fkey'
  ) THEN
    ALTER TABLE installations
      ADD CONSTRAINT installations_sample_id_fkey
      FOREIGN KEY (sample_id) REFERENCES samples(sample_id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_installations_sample_id ON installations(sample_id);
