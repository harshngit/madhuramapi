const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
require('dotenv').config();

async function applySchema() {
	try {
		const schemaPath = path.join(__dirname, '../../db/migrations/user_block_schema.sql');
		const schemaSql = fs.readFileSync(schemaPath, 'utf8');

		console.log('Applying user block schema...');
		await pool.query(schemaSql);

		console.log('Checking columns in auth_users table:');
		const authUsersCols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'auth_users'");
		console.log(authUsersCols.rows.map(r => r.column_name));

		console.log('Checking user_block_history table:');
		const blockHistoryCols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'user_block_history'");
		console.log(blockHistoryCols.rows.map(r => r.column_name));

		console.log('User block schema applied successfully.');
	} catch (error) {
		console.error('Error applying user block schema:', error);
	} finally {
		await pool.end();
	}
}

applySchema();
