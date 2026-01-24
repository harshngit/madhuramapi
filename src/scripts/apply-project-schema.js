const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
require('dotenv').config();

async function applySchema() {
	try {
		const schemaPath = path.join(__dirname, '../../db/project_schema.sql');
		const schemaSql = fs.readFileSync(schemaPath, 'utf8');

		console.log('Applying project schema...');
		await pool.query(schemaSql);
		console.log('Project schema applied successfully.');
	} catch (error) {
		console.error('Error applying schema:', error);
	} finally {
		await pool.end();
	}
}

applySchema();
