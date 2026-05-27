-- ============================================================
-- Migration: Unified Invoice Schema Update (V2)
-- Aligns both Lodha and Hiranandani invoices with new request bodies
-- Safe to run on an existing database
-- ============================================================

BEGIN;

-- ─── 1. LODHA INVOICES ──────────────────────────────────────────────────────

-- Header table updates
ALTER TABLE lodha_invoices
  ADD COLUMN IF NOT EXISTS work_order_date DATE,
  ADD COLUMN IF NOT EXISTS total_igst NUMERIC(15, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_cess NUMERIC(15, 2) NOT NULL DEFAULT 0;

-- Items table updates
ALTER TABLE lodha_invoice_items
  ADD COLUMN IF NOT EXISTS uom TEXT,
  ADD COLUMN IF NOT EXISTS quantity NUMERIC(15, 2),
  ADD COLUMN IF NOT EXISTS rate NUMERIC(15, 2),
  ADD COLUMN IF NOT EXISTS igst_rate NUMERIC(5, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cess_rate NUMERIC(5, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cess_amount NUMERIC(15, 2) NOT NULL DEFAULT 0;


-- ─── 2. HIRANANDANI INVOICES ────────────────────────────────────────────────

-- Rename legacy columns if they exist
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

-- Add Hiranandani-specific fields
ALTER TABLE hiranandani_invoices
  ADD COLUMN IF NOT EXISTS pan_number TEXT,
  ADD COLUMN IF NOT EXISTS pf_number TEXT,
  ADD COLUMN IF NOT EXISTS esic_number TEXT,
  ADD COLUMN IF NOT EXISTS ptr_number TEXT,
  ADD COLUMN IF NOT EXISTS mlwf_number TEXT,
  ADD COLUMN IF NOT EXISTS reverse_charge TEXT DEFAULT 'N',
  ADD COLUMN IF NOT EXISTS supplier_state_name TEXT DEFAULT 'MAHARASHTRA',
  ADD COLUMN IF NOT EXISTS supplier_state_code TEXT DEFAULT '27',
  ADD COLUMN IF NOT EXISTS work_order_date DATE;

-- Items table updates for Hiranandani
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
