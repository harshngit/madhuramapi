-- ============================================================
-- LODHA INVOICE SCHEMA
-- ============================================================

-- 1. lodha_invoices (header table)
CREATE TABLE IF NOT EXISTS lodha_invoices (
  invoice_id                SERIAL PRIMARY KEY,
  
  -- Company Details
  company_name              TEXT,
  company_address           TEXT,
  company_contact_number    TEXT,
  company_email             TEXT,
  company_website           TEXT,
  
  -- Invoice Details
  invoice_title             TEXT,
  invoice_number            TEXT UNIQUE NOT NULL,
  
  -- Tax / Statutory Details
  supplier_gstin            TEXT,
  pan_no                    TEXT,
  pf_number                 TEXT,
  esic_number               TEXT,
  ptr_number                TEXT,
  mlwf_number               TEXT,
  
  -- Charge / Location Details
  reverse_charge            BOOLEAN DEFAULT FALSE,
  state_name                TEXT,
  state_code                TEXT,
  
  -- Receiver / Buyer Details
  receiver_name             TEXT,
  receiver_address          TEXT,
  buyer_gstin               TEXT,
  
  -- Shipping Details
  ship_to_name              TEXT,
  ship_to_state             TEXT,
  ship_to_state_code        TEXT,
  ship_to_gstin             TEXT,
  
  -- Project / Work Details
  project_id                INTEGER,
  building_name             TEXT,
  ra_number                 TEXT,
  work_description          TEXT,
  work_order_number         TEXT,
  service_date_from         DATE,
  service_date_to           DATE,
  
  -- Financial Totals
  total_taxable_value       NUMERIC(15, 2) NOT NULL DEFAULT 0,
  total_cgst                NUMERIC(15, 2) NOT NULL DEFAULT 0,
  total_sgst                NUMERIC(15, 2) NOT NULL DEFAULT 0,
  total_invoice_value       NUMERIC(15, 2) NOT NULL DEFAULT 0,
  round_off                 NUMERIC(10, 2) NOT NULL DEFAULT 0,
  total_invoice_value_words TEXT,
  gst_on_reverse_charge     NUMERIC(15, 2) NOT NULL DEFAULT 0,
  
  -- Footer
  terms                     TEXT,
  authorised_signatory      TEXT,
  
  -- Audit
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. lodha_invoice_items (items table)
CREATE TABLE IF NOT EXISTS lodha_invoice_items (
  item_id                   SERIAL PRIMARY KEY,
  invoice_id                INTEGER NOT NULL REFERENCES lodha_invoices(invoice_id) ON DELETE CASCADE,
  
  sr                        INTEGER,
  description               TEXT,
  sac_code                  TEXT,
  value_of_supply           NUMERIC(15, 2) NOT NULL DEFAULT 0,
  discount                  NUMERIC(15, 2) NOT NULL DEFAULT 0,
  taxable_value             NUMERIC(15, 2) NOT NULL DEFAULT 0,
  cgst_rate                 NUMERIC(5, 2)  NOT NULL DEFAULT 0,
  cgst_amount               NUMERIC(15, 2) NOT NULL DEFAULT 0,
  sgst_rate                 NUMERIC(5, 2)  NOT NULL DEFAULT 0,
  sgst_amount               NUMERIC(15, 2) NOT NULL DEFAULT 0,
  total                     NUMERIC(15, 2) NOT NULL DEFAULT 0,
  
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_lodha_invoice_items_inv_id ON lodha_invoice_items(invoice_id);

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
