  -- ============================================================
  -- Migration: Align Lodha invoice schema with the NEW request body structure (V2)
  -- Safe to run on an existing database
  -- ============================================================

  BEGIN;

  -- ─── Header table updates ───────────────────────────────────────────────────

  ALTER TABLE lodha_invoices
    ADD COLUMN IF NOT EXISTS work_order_date DATE,
    ADD COLUMN IF NOT EXISTS total_igst NUMERIC(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_cess NUMERIC(15, 2) NOT NULL DEFAULT 0;

  -- ─── Items table updates ────────────────────────────────────────────────────

  ALTER TABLE lodha_invoice_items
    ADD COLUMN IF NOT EXISTS uom TEXT,
    ADD COLUMN IF NOT EXISTS quantity NUMERIC(15, 2),
    ADD COLUMN IF NOT EXISTS rate NUMERIC(15, 2),
    ADD COLUMN IF NOT EXISTS igst_rate NUMERIC(5, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cess_rate NUMERIC(5, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cess_amount NUMERIC(15, 2) NOT NULL DEFAULT 0;

  COMMIT;
