-- ============================================================
-- HIRANANDANI INVOICE SCHEMA
-- ============================================================

-- 1. hiranandani_invoices (header table)
CREATE TABLE IF NOT EXISTS hiranandani_invoices (
  invoice_id                SERIAL PRIMARY KEY,
  project_id                INTEGER,
  
  -- Company Details
  company_name              TEXT,
  company_address           TEXT,
  company_contact_number    TEXT,
  company_email             TEXT,
  company_website           TEXT,
  
  -- Invoice Details
  supplier_gstin            TEXT,
  invoice_number            TEXT UNIQUE NOT NULL,
  invoice_date              DATE,
  
  -- Bill To Details
  bill_to_company_name      TEXT,
  bill_to_address           TEXT,
  bill_to_gstin             TEXT,
  bill_to_state             TEXT,
  bill_to_state_code        TEXT,
  
  -- Ship To Details
  ship_to_company_name      TEXT,
  ship_to_address           TEXT,
  ship_to_gstin             TEXT,
  ship_to_state             TEXT,
  ship_to_state_code        TEXT,
  
  -- Project / Work Details
  building_name             TEXT,
  reference_ra_number       TEXT,
  work_description          TEXT,
  work_order_number         TEXT,
  work_order_date           DATE,
  service_date_from         DATE,
  service_date_to           DATE,
  
  -- Financial Totals
  total_value_before_tax    NUMERIC(15, 2) NOT NULL DEFAULT 0,
  total_taxable_value       NUMERIC(15, 2) NOT NULL DEFAULT 0,
  total_cgst                NUMERIC(15, 2) NOT NULL DEFAULT 0,
  total_sgst                NUMERIC(15, 2) NOT NULL DEFAULT 0,
  round_off                 NUMERIC(10, 2) NOT NULL DEFAULT 0,
  total_amount_after_tax    NUMERIC(15, 2) NOT NULL DEFAULT 0,
  gst_on_reverse_charge     NUMERIC(15, 2) NOT NULL DEFAULT 0,
  invoice_amount_in_words   TEXT,
  
  -- Footer
  bank_details              TEXT,
  terms_and_conditions      TEXT,
  authorised_signatory      TEXT,
  
  -- Audit
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. hiranandani_invoice_items (items table)
CREATE TABLE IF NOT EXISTS hiranandani_invoice_items (
  item_id                       SERIAL PRIMARY KEY,
  invoice_id                    INTEGER NOT NULL REFERENCES hiranandani_invoices(invoice_id) ON DELETE CASCADE,
  
  serial_number                 INTEGER,
  goods_or_service_description  TEXT,
  sac_code                      TEXT,
  value_of_supply               NUMERIC(15, 2) NOT NULL DEFAULT 0,
  discount                      NUMERIC(15, 2) NOT NULL DEFAULT 0,
  taxable_value                 NUMERIC(15, 2) NOT NULL DEFAULT 0,
  cgst_rate                     NUMERIC(5, 2)  NOT NULL DEFAULT 0,
  cgst_amount                   NUMERIC(15, 2) NOT NULL DEFAULT 0,
  sgst_rate                     NUMERIC(5, 2)  NOT NULL DEFAULT 0,
  sgst_amount                   NUMERIC(15, 2) NOT NULL DEFAULT 0,
  igst_rate                     NUMERIC(5, 2)  NOT NULL DEFAULT 0,
  igst_amount                   NUMERIC(15, 2) NOT NULL DEFAULT 0,
  cess_rate                     NUMERIC(5, 2)  NOT NULL DEFAULT 0,
  cess_amount                   NUMERIC(15, 2) NOT NULL DEFAULT 0,
  
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_hira_invoice_project_id ON hiranandani_invoices(project_id);
CREATE INDEX IF NOT EXISTS idx_hira_invoice_items_inv_id ON hiranandani_invoice_items(invoice_id);

-- Trigger to update updated_at on hiranandani_invoices
CREATE OR REPLACE FUNCTION update_hiranandani_invoices_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_hiranandani_invoices_updated_at ON hiranandani_invoices;
CREATE TRIGGER trg_update_hiranandani_invoices_updated_at
  BEFORE UPDATE ON hiranandani_invoices
  FOR EACH ROW EXECUTE FUNCTION update_hiranandani_invoices_updated_at();
