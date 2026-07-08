-- MIR template support: Lodha
-- (safe to run independently of add_mir_hiranandani_template.sql, and safe to re-run)

-- Discriminator: which template this MIR row was created with
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

-- Lodha-specific structured fields:
--   request_submission { submitted_to, discipline[] }
--   contractor_part    { material_submittal_approved, approval_ref_no, previous_qty, current_qty,
--                         cumulative_qty, boq_reference, manufacturer_country, supplier,
--                         delivery_note_number, receipt_date, storage_location,
--                         test_certificate_delivered, field_test_compliance_note,
--                         third_party_test_contractor_compliance_note,
--                         third_party_test_lodha_compliance_note,
--                         contractor_name, contractor_signature, contractor_date }
--   lodha_pmc           { inspection_reports{...}, sign_offs{...}, comments, result_code,
--                         result_name, result_signature, result_date, distribution{...} }
--   template_ref, template_revision, template_date
ALTER TABLE mirs
ADD COLUMN IF NOT EXISTS lodha_data JSONB DEFAULT '{}'::jsonb;
