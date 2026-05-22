-- Migration to add project_id to lodha_invoices table
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='lodha_invoices' AND column_name='project_id') THEN
        ALTER TABLE lodha_invoices ADD COLUMN project_id INTEGER;
    END IF;
END $$;

-- Add index for performance
CREATE INDEX IF NOT EXISTS idx_lodha_invoice_project_id ON lodha_invoices(project_id);
