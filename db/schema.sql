CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS auth_users (
  user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone_number TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_reset_token TEXT,
  password_reset_expires TIMESTAMPTZ,
  role TEXT NOT NULL CHECK (role IN ('admin', 'operational_manager', 'po_officer', 'labour')),
  project_list TEXT[] NOT NULL DEFAULT '{}'::text[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS auth_users_set_updated_at ON auth_users;
CREATE TRIGGER auth_users_set_updated_at
BEFORE UPDATE ON auth_users
FOR EACH ROW
EXECUTE PROCEDURE set_updated_at();
