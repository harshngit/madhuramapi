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
    console.log('Starting migration to add user_id to projects...');

    await pool.query(`
      ALTER TABLE projects 
      ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth_users(user_id);
    `);

    console.log('Successfully added user_id column to projects table');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await pool.end();
  }
};

migrate();
