const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { pool } = require('../db');

const migrate = async () => {
  try {
    console.log('Applying billing (RA bills) schema...');

    const schemaPath = path.join(__dirname, '../../db/migrations/add_billing_ra_bills.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');

    await pool.query(schemaSql);

    console.log('Migration completed successfully');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

migrate();
