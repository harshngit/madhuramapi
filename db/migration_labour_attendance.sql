-- ============================================================
-- MIGRATION: ADD LABOUR ATTENDANCE COLUMNS
-- This script adds new columns to auth_users and attendance tables
-- ============================================================

-- 1. Update auth_users table
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'auth_users' AND column_name = 'check_in_time') THEN
        ALTER TABLE auth_users ADD COLUMN check_in_time TIME;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'auth_users' AND column_name = 'check_out_time') THEN
        ALTER TABLE auth_users ADD COLUMN check_out_time TIME;
    END IF;
END $$;

-- 2. Update attendance table
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attendance' AND column_name = 'check_out_time') THEN
        ALTER TABLE attendance ADD COLUMN check_out_time TIMESTAMP;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attendance' AND column_name = 'check_out_photo_selfie') THEN
        ALTER TABLE attendance ADD COLUMN check_out_photo_selfie TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attendance' AND column_name = 'check_out_photo_site') THEN
        ALTER TABLE attendance ADD COLUMN check_out_photo_site TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attendance' AND column_name = 'check_out_location') THEN
        ALTER TABLE attendance ADD COLUMN check_out_location TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attendance' AND column_name = 'check_out_latitude') THEN
        ALTER TABLE attendance ADD COLUMN check_out_latitude NUMERIC;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attendance' AND column_name = 'check_out_longitude') THEN
        ALTER TABLE attendance ADD COLUMN check_out_longitude NUMERIC;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attendance' AND column_name = 'remark') THEN
        ALTER TABLE attendance ADD COLUMN remark TEXT;
    END IF;
END $$;
