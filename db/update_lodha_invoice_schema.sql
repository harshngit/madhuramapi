-- ============================================================
-- Migration: Align Lodha invoice schema with the approved format
-- Safe to run on an existing database
-- ============================================================

BEGIN;

-- ─── Header table updates ───────────────────────────────────────────────────

-- Rename columns that directly map to the Lodha format
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'lodha_invoices' AND column_name = 'company_contact_number'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'lodha_invoices' AND column_name = 'company_phone'
  ) THEN
    ALTER TABLE lodha_invoices RENAME COLUMN company_contact_number TO company_phone;
  END IF;
END $$;

-- Add Lodha-specific fields missing from the previous schema
ALTER TABLE lodha_invoices
  ADD COLUMN IF NOT EXISTS invoice_date DATE,
  ADD COLUMN IF NOT EXISTS buyer_name TEXT,
  ADD COLUMN IF NOT EXISTS buyer_address TEXT,
  ADD COLUMN IF NOT EXISTS buyer_state_name TEXT,
  ADD COLUMN IF NOT EXISTS buyer_state_code TEXT,
  ADD COLUMN IF NOT EXISTS place_of_supply TEXT,
  ADD COLUMN IF NOT EXISTS plant_name TEXT,
  ADD COLUMN IF NOT EXISTS bill_no TEXT,
  ADD COLUMN IF NOT EXISTS total_value NUMERIC(15, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS declaration TEXT,
  ADD COLUMN IF NOT EXISTS electronic_ref_number TEXT,
  ADD COLUMN IF NOT EXISTS electronic_ref_date DATE;

-- Backfill where there is a reasonable legacy source
UPDATE lodha_invoices
SET
  plant_name = COALESCE(plant_name, building_name),
  bill_no = COALESCE(bill_no, ra_number),
  declaration = COALESCE(declaration, terms),
  total_value = COALESCE(NULLIF(total_value, 0), total_invoice_value)
WHERE TRUE;

-- Ensure project lookup index exists
CREATE INDEX IF NOT EXISTS idx_lodha_invoice_project_id ON lodha_invoices(project_id);

-- ─── Items table updates ────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'lodha_invoice_items' AND column_name = 'sr'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'lodha_invoice_items' AND column_name = 'sn'
  ) THEN
    ALTER TABLE lodha_invoice_items RENAME COLUMN sr TO sn;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'lodha_invoice_items' AND column_name = 'total'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'lodha_invoice_items' AND column_name = 'line_total'
  ) THEN
    ALTER TABLE lodha_invoice_items RENAME COLUMN total TO line_total;
  END IF;
END $$;

ALTER TABLE lodha_invoice_items
  ADD COLUMN IF NOT EXISTS igst_amount NUMERIC(15, 2) NOT NULL DEFAULT 0;

COMMIT;
