-- ─────────────────────────────────────────────────────────────────────────────
-- Change vendors.vendor_name / vendor_email / mobile_number (single scalar
-- columns) into vendor_details, a JSONB array of
-- { vendor_name, vendor_email, mobile_number } — a vendor company can now
-- have multiple contact people instead of exactly one.
--
-- Existing single-contact data is preserved by wrapping it into a
-- 1-element array before the old columns are dropped.
--
-- Idempotent / safe to re-run: checks vendor_name's CURRENT type first and
-- skips the conversion entirely if it's already gone / already jsonb.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  col_type text;
BEGIN
  SELECT data_type INTO col_type
    FROM information_schema.columns
   WHERE table_name = 'vendors' AND column_name = 'vendor_name';

  IF col_type IS NULL THEN
    RAISE NOTICE 'vendors.vendor_name does not exist — skipping (already migrated?)';
  ELSIF col_type IN ('json', 'jsonb') THEN
    RAISE NOTICE 'vendors.vendor_name is already %, skipping conversion', col_type;
  ELSE
    ALTER TABLE vendors ADD COLUMN IF NOT EXISTS vendor_details JSONB DEFAULT '[]'::jsonb;

    UPDATE vendors
       SET vendor_details = CASE
         WHEN vendor_name IS NULL AND vendor_email IS NULL AND mobile_number IS NULL
           THEN '[]'::jsonb
         ELSE jsonb_build_array(
           jsonb_strip_nulls(
             jsonb_build_object(
               'vendor_name',   vendor_name,
               'vendor_email',  vendor_email,
               'mobile_number', mobile_number
             )
           )
         )
       END;

    ALTER TABLE vendors DROP COLUMN vendor_name;
    ALTER TABLE vendors DROP COLUMN vendor_email;
    ALTER TABLE vendors DROP COLUMN mobile_number;
  END IF;
END $$;
