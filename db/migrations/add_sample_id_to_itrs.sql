-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Add sample_id to itrs (link an ITR to a sample)
-- Date: 2026-07-09
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE itrs
ADD COLUMN IF NOT EXISTS sample_id TEXT REFERENCES samples(sample_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_itrs_sample_id ON itrs(sample_id);
