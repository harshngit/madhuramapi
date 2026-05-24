-- ============================================================
-- Migration: Align Hiranandani invoice schema with the approved format
-- Safe to run on an existing database
-- ============================================================

BEGIN;

-- ─── Header table updates ───────────────────────────────────────────────────

-- Rename columns that directly map to the new format
DO $$
BEGIN
  -- company_contact_number -> company_phone
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'hiranandani_invoices' AND column_name = 'company_contact_number') 
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'hiranandani_invoices' AND column_name = 'company_phone') THEN
    ALTER TABLE hiranandani_invoices RENAME COLUMN company_contact_number TO company_phone;
  END IF;

  -- bill_to_company_name -> bill_to_name
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'hiranandani_invoices' AND column_name = 'bill_to_company_name') 
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'hiranandani_invoices' AND column_name = 'bill_to_name') THEN
    ALTER TABLE hiranandani_invoices RENAME COLUMN bill_to_company_name TO bill_to_name;
  END IF;

  -- ship_to_company_name -> ship_to_name
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'hiranandani_invoices' AND column_name = 'ship_to_company_name') 
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'hiranandani_invoices' AND column_name = 'ship_to_name') THEN
    ALTER TABLE hiranandani_invoices RENAME COLUMN ship_to_company_name TO ship_to_name;
  END IF;

  -- reference_ra_number -> ra_number
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'hiranandani_invoices' AND column_name = 'reference_ra_number') 
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'hiranandani_invoices' AND column_name = 'ra_number') THEN
    ALTER TABLE hiranandani_invoices RENAME COLUMN reference_ra_number TO ra_number;
  END IF;

  -- total_value_before_tax -> total_before_tax
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'hiranandani_invoices' AND column_name = 'total_value_before_tax') 
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'hiranandani_invoices' AND column_name = 'total_before_tax') THEN
    ALTER TABLE hiranandani_invoices RENAME COLUMN total_value_before_tax TO total_before_tax;
  END IF;

  -- invoice_amount_in_words -> invoice_amount_words
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'hiranandani_invoices' AND column_name = 'invoice_amount_in_words') 
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'hiranandani_invoices' AND column_name = 'invoice_amount_words') THEN
    ALTER TABLE hiranandani_invoices RENAME COLUMN invoice_amount_in_words TO invoice_amount_words;
  END IF;
END $$;

-- Add Hiranandani-specific fields missing from the previous schema
ALTER TABLE hiranandani_invoices
  ADD COLUMN IF NOT EXISTS pan_number TEXT,
  ADD COLUMN IF NOT EXISTS pf_number TEXT,
  ADD COLUMN IF NOT EXISTS esic_number TEXT,
  ADD COLUMN IF NOT EXISTS ptr_number TEXT,
  ADD COLUMN IF NOT EXISTS mlwf_number TEXT,
  ADD COLUMN IF NOT EXISTS reverse_charge TEXT DEFAULT 'N',
  ADD COLUMN IF NOT EXISTS supplier_state_name TEXT DEFAULT 'MAHARASHTRA',
  ADD COLUMN IF NOT EXISTS supplier_state_code TEXT DEFAULT '27';

-- ─── Items table updates ────────────────────────────────────────────────────

DO $$
BEGIN
  -- serial_number -> sn
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'hiranandani_invoice_items' AND column_name = 'serial_number') 
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'hiranandani_invoice_items' AND column_name = 'sn') THEN
    ALTER TABLE hiranandani_invoice_items RENAME COLUMN serial_number TO sn;
  END IF;

  -- goods_or_service_description -> description
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'hiranandani_invoice_items' AND column_name = 'goods_or_service_description') 
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'hiranandani_invoice_items' AND column_name = 'description') THEN
    ALTER TABLE hiranandani_invoice_items RENAME COLUMN goods_or_service_description TO description;
  END IF;
END $$;

ALTER TABLE hiranandani_invoice_items
  ADD COLUMN IF NOT EXISTS line_total NUMERIC(15, 2) NOT NULL DEFAULT 0;

COMMIT;
