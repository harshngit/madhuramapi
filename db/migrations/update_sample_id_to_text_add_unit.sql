-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Change sample_id from INTEGER to TEXT and add unit to item_description
-- Date: 2026-06-03
-- ─────────────────────────────────────────────────────────────────────────────

-- Step 1: Alter sample_id column type from INTEGER to TEXT
ALTER TABLE samples ALTER COLUMN sample_id TYPE TEXT USING sample_id::TEXT;

-- Step 2: Back-fill 'unit' field into existing item_description JSONB rows
--         Idempotent — safe to run multiple times.
UPDATE samples
SET item_description = (
    SELECT jsonb_agg(
        CASE
            WHEN (elem->>'unit') IS NULL
            THEN elem
                || jsonb_build_object('unit', COALESCE(elem->>'unit', ''))
            ELSE elem
        END
    )
    FROM jsonb_array_elements(item_description) AS elem
),
updated_at = CURRENT_TIMESTAMP
WHERE item_description IS NOT NULL
  AND item_description != '[]'::jsonb;

-- Step 3: Verify
SELECT
    s.id,
    s.sample_id,
    elem->>'sr_no'       AS sr_no,
    elem->>'item_name'   AS item_name,
    elem->>'brand_name'  AS brand_name,
    elem->>'description' AS description,
    elem->>'unit'        AS unit,
    elem->>'quantity'    AS quantity,
    elem->>'value'       AS value
FROM samples s,
     jsonb_array_elements(s.item_description) AS elem
ORDER BY s.id, (elem->>'sr_no')::int;
