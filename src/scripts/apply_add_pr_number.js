const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
require('dotenv').config();

async function applyMigration() {
  try {
    const migrationPath = path.join(__dirname, '../../db/migrations/add_pr_number_to_purchase_requisitions.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    console.log('Applying PR number column migration...');
    await pool.query(migrationSql);

    console.log('PR number column migration applied successfully!');
  } catch (error) {
    console.error('Error applying migration:', error);
  } finally {
    await pool.end();
  }
}

applyMigration();
