-- ============================================================
-- ACCESS CONTROL SCHEMA
-- File: access_control_schema.sql
-- Description: Per-user section-level permission system.
--              Each row = one user + one section + true/false access.
-- Run once on your existing database (safe, uses IF NOT EXISTS).
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. SECTION DEFINITIONS TABLE
--    Master list of all sections / modules in the app.
--    Add new sections here as the app grows.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS access_sections (
    section_id    SERIAL PRIMARY KEY,
    section_key   TEXT NOT NULL UNIQUE,   -- e.g. 'quotation', 'inventory', 'po'
    section_label TEXT NOT NULL,          -- Display name: 'Quotation', 'Inventory'
    description   TEXT,
    is_active     BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed default sections matching the Madhuram app
INSERT INTO access_sections (section_key, section_label, description) VALUES
  ('dashboard',         'Dashboard',           'Main dashboard and activity feed'),
  ('quotation',         'Quotation',           'Quotation creation, editing and viewing'),
  ('boq',               'BOQ',                 'Bill of Quantities management'),
  ('inventory',         'Inventory',           'Inventory items, stock in/out'),
  ('inventory_history', 'Inventory History',   'View inventory audit logs'),
  ('po',                'Purchase Order',      'Purchase order creation and tracking'),
  ('pr',                'Purchase Request',    'Purchase request management'),
  ('mir',               'MIR',                 'Material Inspection Report'),
  ('itr',               'ITR',                 'Inspection & Test Records'),
  ('delivery_challan',  'Delivery Challan',    'Delivery challan management'),
  ('vendors',           'Vendors',             'Vendor management'),
  ('vendor_price_list', 'Vendor Price List',   'Vendor rate / price list'),
  ('attendance',        'Attendance',          'Labour attendance tracking'),
  ('projects',          'Projects',            'Project listing and management'),
  ('reports',           'Reports',             'Reports and analytics'),
  ('settings',          'Settings',            'Application settings and access control')
ON CONFLICT (section_key) DO NOTHING;

-- ──────────────────────────────────────────────────────────────
-- 2. USER ACCESS PERMISSIONS TABLE
--    One row per user per section.
--    has_access = TRUE  → user can see/use the section
--    has_access = FALSE → section is hidden / blocked for user
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_access_permissions (
    permission_id   SERIAL PRIMARY KEY,

    -- Reference to auth_users
    user_id         UUID NOT NULL
                      REFERENCES auth_users(user_id)
                      ON DELETE CASCADE,

    -- Reference to section
    section_id      INTEGER NOT NULL
                      REFERENCES access_sections(section_id)
                      ON DELETE CASCADE,

    -- The actual permission flag
    has_access      BOOLEAN NOT NULL DEFAULT FALSE,

    -- Who granted / last modified this permission
    granted_by      UUID REFERENCES auth_users(user_id),
    granted_by_name TEXT,

    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- One row per user per section
    UNIQUE (user_id, section_id)
);

-- ──────────────────────────────────────────────────────────────
-- 3. INDEXES
-- ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_uap_user_id    ON user_access_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_uap_section_id ON user_access_permissions(section_id);
CREATE INDEX IF NOT EXISTS idx_uap_has_access ON user_access_permissions(has_access);

-- ──────────────────────────────────────────────────────────────
-- 4. AUTO-TIMESTAMP TRIGGER
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_uap_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_uap_updated_at ON user_access_permissions;
CREATE TRIGGER trg_uap_updated_at
  BEFORE UPDATE ON user_access_permissions
  FOR EACH ROW
  EXECUTE FUNCTION fn_uap_set_updated_at();

-- ──────────────────────────────────────────────────────────────
-- 5. HELPER VIEW — full permissions with user & section details
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW user_access_full AS
SELECT
    p.permission_id,
    p.user_id,
    u.name            AS user_name,
    u.email           AS user_email,
    u.role            AS user_role,
    p.section_id,
    s.section_key,
    s.section_label,
    s.description     AS section_description,
    p.has_access,
    p.granted_by,
    p.granted_by_name,
    p.created_at,
    p.updated_at
FROM user_access_permissions p
JOIN auth_users       u ON u.user_id   = p.user_id
JOIN access_sections  s ON s.section_id = p.section_id
WHERE s.is_active = TRUE;

COMMENT ON TABLE user_access_permissions IS
  'Per-user section-level access control. has_access=true grants access to the section.';
