-- ============================================================
-- PATCH Migration: Add field_role + formula_description columns
-- to the already-existing quotation_field_definitions table.
--
-- Run this in pgAdmin if you already ran the v1 migration.
-- ============================================================

-- 1. Add field_role column (if not already present)
ALTER TABLE quotation_field_definitions
  ADD COLUMN IF NOT EXISTS field_role VARCHAR(32) NOT NULL DEFAULT 'input';

-- 2. Add formula_description column (if not already present)
ALTER TABLE quotation_field_definitions
  ADD COLUMN IF NOT EXISTS formula_description TEXT;

-- 3. Drop the old formula column from v1 (if it exists)
ALTER TABLE quotation_field_definitions
  DROP COLUMN IF EXISTS formula;

-- 4. Now seed / update all the static field roles correctly
UPDATE quotation_field_definitions SET field_role = 'text',   formula_description = NULL
  WHERE field_key IN ('item_no', 'description', 'unit');

UPDATE quotation_field_definitions SET field_role = 'input',
  formula_description = 'Direct user input. Used as the multiplier: amount = total_rate × quantity'
  WHERE field_key = 'quantity';

UPDATE quotation_field_definitions SET field_role = 'base',
  formula_description = 'Fallback base rate. Used only when basic_rate is absent or zero.'
  WHERE field_key = 'rate';

UPDATE quotation_field_definitions SET field_role = 'base',
  formula_description = 'Primary base rate. Engine variable: basicRate = basic_rate ?? rate'
  WHERE field_key = 'basic_rate';

UPDATE quotation_field_definitions SET field_role = 'input',
  formula_description = 'Percentage discount. Engine: total_rate -= basicRate × discount / 100'
  WHERE field_key = 'discount';

UPDATE quotation_field_definitions SET field_role = 'percent_addon',
  formula_description = 'Added to percentSum. Effect: total_rate += basicRate × fittings / 100'
  WHERE field_key = 'fittings';

UPDATE quotation_field_definitions SET field_role = 'percent_addon',
  formula_description = 'Added to percentSum. Effect: total_rate += basicRate × transportation / 100'
  WHERE field_key = 'transportation';

UPDATE quotation_field_definitions SET field_role = 'percent_addon',
  formula_description = 'Added to percentSum. Effect: total_rate += basicRate × support / 100'
  WHERE field_key = 'support';

UPDATE quotation_field_definitions SET field_role = 'percent_addon',
  formula_description = 'Added to percentSum. Effect: total_rate += basicRate × miscellaneous / 100'
  WHERE field_key = 'miscellaneous';

UPDATE quotation_field_definitions SET field_role = 'percent_addon',
  formula_description = 'Added to percentSum. Effect: total_rate += basicRate × total_material_price / 100'
  WHERE field_key = 'total_material_price';

UPDATE quotation_field_definitions SET field_role = 'percent_addon',
  formula_description = 'Added to percentSum. Effect: total_rate += basicRate × labour / 100'
  WHERE field_key = 'labour';

UPDATE quotation_field_definitions SET field_role = 'percent_addon',
  formula_description = 'Added to percentSum. Effect: total_rate += basicRate × material_plus_labour / 100'
  WHERE field_key = 'material_plus_labour';

UPDATE quotation_field_definitions SET field_role = 'percent_addon',
  formula_description = 'Added to percentSum. Effect: total_rate += basicRate × profit / 100'
  WHERE field_key = 'profit';

UPDATE quotation_field_definitions SET field_role = 'derived',
  formula_description = 'Engine computed: basicRate + (basicRate × percentSum / 100) − (basicRate × discount / 100)'
  WHERE field_key = 'total_rate';

UPDATE quotation_field_definitions SET field_role = 'derived',
  formula_description = 'Engine computed: total_rate × quantity'
  WHERE field_key = 'amount';

UPDATE quotation_field_definitions SET field_role = 'derived',
  formula_description = 'Alias of amount. Set = amount after every recalculation.'
  WHERE field_key = 'final_rate_after_discount';