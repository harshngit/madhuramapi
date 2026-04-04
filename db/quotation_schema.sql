-- ============================================================
-- QUOTATION SCHEMA
-- Project: Somerset PHE Works (and general quotation module)
-- DB: PostgreSQL
-- ============================================================

-- ─── 1. quotations  (header / summary table) ────────────────────────────────
DROP TABLE IF EXISTS quotations CASCADE;
CREATE TABLE IF NOT EXISTS quotations (
  id                  SERIAL PRIMARY KEY,

  -- Project linkage (optional)
  project_name        TEXT,
  client_name         TEXT,

  -- Quotation identity
  quotation_no        TEXT UNIQUE,          -- e.g. "QT-2026-001"
  quotation_date      DATE,

  -- Financial totals (auto-computed and stored for fast reads)
  total_amount        NUMERIC(15, 2) NOT NULL DEFAULT 0,
  gst_percentage      NUMERIC(5, 2)  NOT NULL DEFAULT 18,
  gst_amount          NUMERIC(15, 2) NOT NULL DEFAULT 0,
  grand_total         NUMERIC(15, 2) NOT NULL DEFAULT 0,

  -- Status workflow
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','pending','sent','approved','rejected')),

  -- Source file paths (can be multiple)
  boq_files           JSONB DEFAULT '[]'::jsonb,
  drawing_files       JSONB DEFAULT '[]'::jsonb,

  -- Revised offer details
  last_date_revised_offer DATE,
  is_revised_offer        BOOLEAN DEFAULT FALSE,

  notes               TEXT,

  -- Audit
  created_by          TEXT,
  created_by_name     TEXT,
  updated_by          TEXT,
  updated_by_name     TEXT,
  edit_history        JSONB DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at on any row change
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS quotations_updated_at ON quotations;
CREATE TRIGGER quotations_updated_at
  BEFORE UPDATE ON quotations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── 2. quotation_items  (BOQ line items) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS quotation_items (
  id                          SERIAL PRIMARY KEY,
  quotation_id                INTEGER NOT NULL
                                REFERENCES quotations(id) ON DELETE CASCADE,

  -- Item identity (maps to the BOQ Item No. column, e.g. "1", "2.1", "10.34")
  item_no                     TEXT,

  -- Section grouping (e.g. "SANITARY FIXTURES & FITTINGS", "COLD & HOT WATER SUPPLY")
  sub_head                    TEXT,

  -- Core BOQ fields
  description                 TEXT,
  unit                        TEXT,                     -- Nos., Rmt., Kg., Mtr., etc.
  quantity                    NUMERIC(12, 3),
  rate                        NUMERIC(12, 2),
  amount                      NUMERIC(15, 2),           -- quantity × rate

  -- Pricing breakdown columns (from the BOQ sheet)
  basic_rate                  NUMERIC(12, 2),
  discount                    NUMERIC(12, 2),
  final_rate_after_discount   NUMERIC(12, 2),
  fittings                    NUMERIC(12, 2),
  transportation              NUMERIC(12, 2),
  support                     NUMERIC(12, 2),
  miscellaneous               NUMERIC(12, 2),
  total_material_price        NUMERIC(15, 2),
  labour                      NUMERIC(12, 2),
  material_plus_labour        NUMERIC(15, 2),
  profit                      NUMERIC(12, 2),
  total_rate                  NUMERIC(12, 2),

  -- Display ordering
  sort_order                  INTEGER NOT NULL DEFAULT 0,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 3. Indexes ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_quotations_status        ON quotations(status);
CREATE INDEX IF NOT EXISTS idx_quotation_items_quot_id  ON quotation_items(quotation_id);
CREATE INDEX IF NOT EXISTS idx_quotation_items_sub_head ON quotation_items(sub_head);

-- ─── 4. Handy view: quotation with item count + totals ───────────────────────
CREATE OR REPLACE VIEW v_quotations_summary AS
SELECT
  q.*,
  COUNT(qi.id)                            AS items_count,
  COALESCE(SUM(qi.amount), 0)             AS computed_total_amount
FROM quotations q
LEFT JOIN quotation_items qi ON qi.quotation_id = q.id
GROUP BY q.id;
