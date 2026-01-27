const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

const migrate = async () => {
  try {
    console.log('Starting migration...');

    // 1. Rename product_duration to project_startdate if it exists
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS(SELECT * FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'product_duration') THEN
          ALTER TABLE projects RENAME COLUMN product_duration TO project_startdate;
        END IF;
      END $$;
    `);
    console.log('Renamed product_duration to project_startdate (if existed)');

    // 2. Add new columns
    await pool.query(`
      ALTER TABLE projects 
      ADD COLUMN IF NOT EXISTS location TEXT,
      ADD COLUMN IF NOT EXISTS floor TEXT,
      ADD COLUMN IF NOT EXISTS estimate_value TEXT,
      ADD COLUMN IF NOT EXISTS wo_number TEXT;
    `);
    console.log('Added new columns (location, floor, estimate_value, wo_number)');

    // 3. Drop old columns
    await pool.query(`
      ALTER TABLE projects DROP COLUMN IF EXISTS work_order_information;
    `);
    console.log('Dropped work_order_information (if existed)');

    console.log('Migration completed successfully');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await pool.end();
  }
};

migrate();
