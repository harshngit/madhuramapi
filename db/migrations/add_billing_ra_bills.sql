-- ─────────────────────────────────────────────────────────────────────────────
-- Billing: RA (running account) bills per project, in the builder's format.
--
-- 1. projects gets the details a bill needs (which builder's format, work
--    order date/value, codes, client billing address/GSTIN, site address).
-- 2. ra_bills holds one row per RA bill: number, status, the full bill
--    workbook as edited in the app (sheets JSONB), and the amount snapshot.
-- 3. ra_bill_items holds the billed quantity per BOQ item and payment stage,
--    so the next RA's "previous" quantities can be worked out by the server.
--
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ─── 1. Project billing details ─────────────────────────────────────────────
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS builder        TEXT,
  ADD COLUMN IF NOT EXISTS wo_date        DATE,
  ADD COLUMN IF NOT EXISTS wo_value       NUMERIC(15, 2),
  ADD COLUMN IF NOT EXISTS project_code   TEXT,
  ADD COLUMN IF NOT EXISTS vendor_code    TEXT,
  ADD COLUMN IF NOT EXISTS client_address TEXT,
  ADD COLUMN IF NOT EXISTS client_gstin   TEXT,
  ADD COLUMN IF NOT EXISTS site_address   TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_builder_check') THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_builder_check
      CHECK (builder IS NULL OR builder IN ('hiranandani', 'lodha', 'rustomjee'));
  END IF;
END $$;

-- ─── 2. RA bills ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ra_bills (
  bill_id           SERIAL PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  builder           TEXT NOT NULL CHECK (builder IN ('hiranandani', 'lodha', 'rustomjee')),
  ra_no             INTEGER NOT NULL CHECK (ra_no > 0),
  bill_date         DATE,
  service_from      DATE,
  service_to        DATE,
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'submitted', 'certified', 'paid')),
  is_final          BOOLEAN NOT NULL DEFAULT FALSE,
  file_name         TEXT,
  sheets            JSONB NOT NULL DEFAULT '[]'::jsonb,
  this_bill_amount  NUMERIC(15, 2) NOT NULL DEFAULT 0,
  previous_amount   NUMERIC(15, 2) NOT NULL DEFAULT 0,
  cumulative_amount NUMERIC(15, 2) NOT NULL DEFAULT 0,
  gst_amount        NUMERIC(15, 2) NOT NULL DEFAULT 0,
  total_with_gst    NUMERIC(15, 2) NOT NULL DEFAULT 0,
  certified_amount  NUMERIC(15, 2),
  invoice_id        INTEGER,
  export_file       TEXT,
  remarks           TEXT,
  -- bumped on every save; a save carrying an older version is rejected (409)
  version           INTEGER NOT NULL DEFAULT 1,
  submitted_at      TIMESTAMP,
  certified_at      TIMESTAMP,
  paid_at           TIMESTAMP,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ra_bills_project_ra_unique UNIQUE (project_id, ra_no)
);

CREATE INDEX IF NOT EXISTS idx_ra_bills_project_id ON ra_bills(project_id);

-- ─── 3. Billed quantities per BOQ item and stage ────────────────────────────
-- stage is the payment stage the builder pays the item in, e.g. Lodha's
-- supply (60%) / installation (25%) / testing (10%) / handover (5%); "full"
-- when an item is billed in one go (Hiranandani).
CREATE TABLE IF NOT EXISTS ra_bill_items (
  bill_item_id  SERIAL PRIMARY KEY,
  bill_id       INTEGER NOT NULL REFERENCES ra_bills(bill_id) ON DELETE CASCADE,
  boq_id        INTEGER REFERENCES boqs(boq_id) ON DELETE SET NULL,
  item_no       TEXT,
  description   TEXT,
  unit          TEXT,
  stage         TEXT NOT NULL DEFAULT 'full',
  share_pct     NUMERIC(6, 3) NOT NULL DEFAULT 100,
  rate          NUMERIC(15, 2) NOT NULL DEFAULT 0,
  wo_qty        NUMERIC(15, 3),
  previous_qty  NUMERIC(15, 3) NOT NULL DEFAULT 0,
  current_qty   NUMERIC(15, 3) NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ra_bill_items_bill_id ON ra_bill_items(bill_id);
CREATE INDEX IF NOT EXISTS idx_ra_bill_items_boq_id ON ra_bill_items(boq_id);

COMMIT;
