-- ─────────────────────────────────────────────────────────────────────────────
-- Vendor Comparison is now a two-stage workflow on the same table:
--   Stage 1 (compare):  POST /api/vendor-comparison            → sets vendorlist
--   Stage 2 (finalize): POST /api/vendor-comparison-finalize   → sets approved_vendor,
--                        pricelist (the winning flat line items), upload_document
--
-- vendorlist stores the multi-vendor comparison data:
--   [ { vendor_id, vendor_name, pricelist: [ { item_no, item_code, item_description,
--       total_qty, rate, amount, discount, sgst, cgst } ] } ]
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE vendor_comparisons
ADD COLUMN IF NOT EXISTS vendorlist JSONB DEFAULT '[]'::jsonb;
