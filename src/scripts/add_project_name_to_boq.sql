-- Migration: Add project_name to boqs table
-- Date: 2026-05-11

ALTER TABLE boqs ADD COLUMN IF NOT EXISTS project_name TEXT;
