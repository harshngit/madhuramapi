-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Add approved_vendor to vendor_comparisons
-- Date: 2026-07-09
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE vendor_comparisons
ADD COLUMN IF NOT EXISTS approved_vendor INTEGER REFERENCES vendors(vendor_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_vc_approved_vendor ON vendor_comparisons(approved_vendor);
