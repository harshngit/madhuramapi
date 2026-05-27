-- ============================================================
-- LODHA INVOICE SCHEMA
-- ============================================================

-- 1. lodha_invoices (header table)
CREATE TABLE IF NOT EXISTS lodha_invoices (
  invoice_id                SERIAL PRIMARY KEY,
  
  -- Company Details
  project_id                INTEGER,
  company_name              TEXT,
  company_address           TEXT,
  company_phone             TEXT,
  company_email             TEXT,
  company_website           TEXT,
  
  -- Invoice Details
  invoice_number            TEXT UNIQUE NOT NULL,
  invoice_date              DATE,
  supplier_gstin            TEXT,
  
  -- Buyer Details
  buyer_name                TEXT,
  buyer_address             TEXT,
  buyer_state_name          TEXT,
  buyer_state_code          TEXT,
  buyer_gstin               TEXT,

  -- Receiver Details
  receiver_name             TEXT,
  receiver_address          TEXT,
  place_of_supply           TEXT,
  
  -- Project / Work Details
  work_order_number         TEXT,
  work_order_date           DATE,
  plant_name                TEXT,
  bill_no                   TEXT,
  
  -- Financial Totals
  total_taxable_value       NUMERIC(15, 2) NOT NULL DEFAULT 0,
  total_cgst                NUMERIC(15, 2) NOT NULL DEFAULT 0,
  total_sgst                NUMERIC(15, 2) NOT NULL DEFAULT 0,
  total_igst                NUMERIC(15, 2) NOT NULL DEFAULT 0,
  total_cess                NUMERIC(15, 2) NOT NULL DEFAULT 0,
  total_value               NUMERIC(15, 2) NOT NULL DEFAULT 0,
  total_invoice_value       NUMERIC(15, 2) NOT NULL DEFAULT 0,
  total_invoice_value_words TEXT,
  
  -- Footer
  declaration               TEXT,
  electronic_ref_number     TEXT,
  electronic_ref_date       DATE,
  authorised_signatory      TEXT,
  
  -- Audit
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. lodha_invoice_items (items table)
CREATE TABLE IF NOT EXISTS lodha_invoice_items (
  item_id                   SERIAL PRIMARY KEY,
  invoice_id                INTEGER NOT NULL REFERENCES lodha_invoices(invoice_id) ON DELETE CASCADE,
  
  sn                        INTEGER,
  description               TEXT,
  sac_code                  TEXT,
  uom                       TEXT,
  quantity                  NUMERIC(15, 2),
  rate                      NUMERIC(15, 2),
  value_of_supply           NUMERIC(15, 2) NOT NULL DEFAULT 0,
  discount                  NUMERIC(15, 2) NOT NULL DEFAULT 0,
  taxable_value             NUMERIC(15, 2) NOT NULL DEFAULT 0,
  cgst_rate                 NUMERIC(5, 2)  NOT NULL DEFAULT 0,
  cgst_amount               NUMERIC(15, 2) NOT NULL DEFAULT 0,
  sgst_rate                 NUMERIC(5, 2)  NOT NULL DEFAULT 0,
  sgst_amount               NUMERIC(15, 2) NOT NULL DEFAULT 0,
  igst_rate                 NUMERIC(5, 2)  NOT NULL DEFAULT 0,
  igst_amount               NUMERIC(15, 2) NOT NULL DEFAULT 0,
  cess_rate                 NUMERIC(5, 2)  NOT NULL DEFAULT 0,
  cess_amount               NUMERIC(15, 2) NOT NULL DEFAULT 0,
  line_total                NUMERIC(15, 2) NOT NULL DEFAULT 0,
  
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_lodha_invoice_items_inv_id ON lodha_invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_lodha_invoice_project_id ON lodha_invoices(project_id);

-- Trigger to update updated_at on lodha_invoices
CREATE OR REPLACE FUNCTION update_lodha_invoices_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_lodha_invoices_updated_at ON lodha_invoices;
CREATE TRIGGER trg_update_lodha_invoices_updated_at
  BEFORE UPDATE ON lodha_invoices
  FOR EACH ROW EXECUTE FUNCTION update_lodha_invoices_updated_at();
