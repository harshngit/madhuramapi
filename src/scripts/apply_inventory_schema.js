const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
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
    console.log('Applying inventory schema...');
    
    const schemaPath = path.join(__dirname, '../../db/inventory_schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');

    await pool.query(schemaSql);
    
    console.log('Migration completed successfully');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await pool.end();
  }
};

migrate();
