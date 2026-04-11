-- ============================================================
-- Migration: Dynamic fields for quotation items
-- Run this once against your madhuram_backend database
-- ============================================================

-- Table that stores field definitions
CREATE TABLE IF NOT EXISTS quotation_field_definitions (
  id            SERIAL PRIMARY KEY,
  field_key     VARCHAR(64)  NOT NULL UNIQUE,   -- machine-readable key, e.g. "erection_cost"
  label         VARCHAR(128) NOT NULL,           -- human-readable column header, e.g. "Erection Cost"
  data_type     VARCHAR(16)  NOT NULL DEFAULT 'number',  -- 'number' | 'text' | 'percent'
  -- Calculation formula stored as a string.
  -- Supported variables: any other field_key wrapped in {braces}.
  -- Examples:
  --   "{quantity} * {rate}"
  --   "{basic_rate} * (1 - {discount} / 100)"
  --   "{total_material_price} + {labour}"
  formula       TEXT,
  description   TEXT,                            -- optional tooltip / notes
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order    INTEGER      NOT NULL DEFAULT 0,
  created_by    VARCHAR(128),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Index for active fields in display order
CREATE INDEX IF NOT EXISTS idx_qfd_active_sort
  ON quotation_field_definitions (is_active, sort_order);

-- Dynamic values for each item × field combination
CREATE TABLE IF NOT EXISTS quotation_item_dynamic_values (
  id            SERIAL PRIMARY KEY,
  item_id       INTEGER      NOT NULL REFERENCES quotation_items(id) ON DELETE CASCADE,
  field_id      INTEGER      NOT NULL REFERENCES quotation_field_definitions(id) ON DELETE CASCADE,
  value         NUMERIC,
  text_value    TEXT,                            -- used when data_type = 'text'
  computed      BOOLEAN      NOT NULL DEFAULT FALSE,  -- TRUE if value was auto-calculated
  UNIQUE (item_id, field_id)
);

CREATE INDEX IF NOT EXISTS idx_qidv_item ON quotation_item_dynamic_values (item_id);
CREATE INDEX IF NOT EXISTS idx_qidv_field ON quotation_item_dynamic_values (field_id);

-- Seed the existing hard-coded columns as field definitions
-- so the UI can treat everything uniformly
INSERT INTO quotation_field_definitions
  (field_key, label, data_type, formula, sort_order)
VALUES
  ('item_no',                   'Item No',                   'text',    NULL,                                              1),
  ('description',               'Description',               'text',    NULL,                                              2),
  ('unit',                      'Unit',                      'text',    NULL,                                              3),
  ('quantity',                  'Qty',                       'number',  NULL,                                              4),
  ('rate',                      'Rate',                      'number',  NULL,                                              5),
  ('amount',                    'Amount',                    'number',  '{quantity} * {rate}',                             6),
  ('basic_rate',                'Basic Rate',                'number',  NULL,                                              7),
  ('discount',                  'Discount (%)',              'percent', NULL,                                              8),
  ('final_rate_after_discount', 'Rate After Discount',       'number',  '{basic_rate} * (1 - {discount} / 100)',           9),
  ('fittings',                  'Fittings',                  'number',  NULL,                                             10),
  ('transportation',            'Transportation',            'number',  NULL,                                             11),
  ('support',                   'Support',                   'number',  NULL,                                             12),
  ('miscellaneous',             'Miscellaneous',             'number',  NULL,                                             13),
  ('total_material_price',      'Total Material Price',      'number',  '{final_rate_after_discount} + {fittings} + {transportation} + {support} + {miscellaneous}', 14),
  ('labour',                    'Labour',                    'number',  NULL,                                             15),
  ('material_plus_labour',      'Material + Labour',         'number',  '{total_material_price} + {labour}',              16),
  ('profit',                    'Profit (%)',                'percent', NULL,                                             17),
  ('total_rate',                'Total Rate',                'number',  '{material_plus_labour} * (1 + {profit} / 100)', 18)
ON CONFLICT (field_key) DO NOTHING;
