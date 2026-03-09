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
    console.log('Starting migration for Vendor Price List tables...');

    // 1. Create vendor_price_lists table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vendor_price_lists (
        price_list_id SERIAL PRIMARY KEY,
        vendor_id INTEGER REFERENCES vendors(vendor_id) ON DELETE CASCADE,
        version_name TEXT, 
        status TEXT CHECK (status IN ('active', 'inactive', 'archived')) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Created vendor_price_lists table');

    // 2. Create vendor_price_list_items table
    // Using user specified column names (normalized for SQL)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vendor_price_list_items (
        item_id SERIAL PRIMARY KEY,
        price_list_id INTEGER REFERENCES vendor_price_lists(price_list_id) ON DELETE CASCADE,
        items_name TEXT,
        hsn_code TEXT,
        item_code TEXT,
        category TEXT,
        product_name TEXT,
        size_inch TEXT,
        size_mm TEXT,
        price_per_pic NUMERIC,
        discount_price NUMERIC,
        net_price NUMERIC,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Created vendor_price_list_items table');
    
    // Add indexes for performance
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vpl_vendor_id ON vendor_price_lists(vendor_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vpli_price_list_id ON vendor_price_list_items(price_list_id);`);
    console.log('Added indexes');

    console.log('Migration completed successfully');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await pool.end();
  }
};

migrate();
