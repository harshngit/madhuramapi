const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
require('dotenv').config();

async function applyMigration() {
  try {
    const migrationPath = path.join(__dirname, '../../db/migrations/add_half_day_status.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    console.log('Applying half day status migration...');
    await pool.query(migrationSql);

    console.log('Half day status migration applied successfully!');
  } catch (error) {
    console.error('Error applying migration:', error);
  } finally {
    await pool.end();
  }
}

applyMigration();
