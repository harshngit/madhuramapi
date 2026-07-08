-- MIR template support: Hiranandani
-- (safe to run independently of add_mir_lodha_template.sql, and safe to re-run)

-- Discriminator: which template this MIR row was created with
-- (idempotent here too, in case this file runs before the lodha migration)
ALTER TABLE mirs
ADD COLUMN IF NOT EXISTS template_type TEXT CHECK (template_type IN ('lodha', 'hiranandani'));

-- refrence_docs_attached becomes a JSONB array of { file_name, file_url } objects
-- (was a plain TEXT column before; existing values are wrapped into that shape)
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'mirs' AND column_name = 'refrence_docs_attached') <> 'jsonb' THEN
    ALTER TABLE mirs
      ALTER COLUMN refrence_docs_attached TYPE JSONB
      USING (
        CASE WHEN refrence_docs_attached IS NULL OR refrence_docs_attached = ''
             THEN '[]'::jsonb
             ELSE jsonb_build_array(jsonb_build_object('file_name', refrence_docs_attached, 'file_url', refrence_docs_attached))
        END
      );
    ALTER TABLE mirs ALTER COLUMN refrence_docs_attached SET DEFAULT '[]'::jsonb;
  END IF;
END $$;

-- Hiranandani-specific structured fields:
--   control_form, revision, location, material_to_inspect, storage_location, attachments
--   notes        { manufacturer, purchase_order_no, manufacturer_date, challan_invoice_no,
--                  expiry_date, delivery_date, batch_no, material_submittal_ref, source_country,
--                  specification_ref, quantity_delivered, drawings_ref }
--   material_rows[]  { material, size, quantity, unit }
--   mir_raised_by_name, mir_raised_by_date_signature,
--   received_by_name, received_by_date_signature,
--   inspection_engineer_comments, approval_code,
--   checked_by_client_representative, checked_by_date_signature,
--   issued_by_name, issued_by_date_signature,
--   close_out    { action_taken, checked_by, status, date_signature }
ALTER TABLE mirs
ADD COLUMN IF NOT EXISTS hiranandani_data JSONB DEFAULT '{}'::jsonb;
