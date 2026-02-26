const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
require('dotenv').config();

async function applySchema() {
	try {
		const coreSchemaPath = path.join(__dirname, '../../db/schema.sql');
		const coreSchemaSql = fs.readFileSync(coreSchemaPath, 'utf8');

		const projectSchemaPath = path.join(__dirname, '../../db/project_schema.sql');
		const projectSchemaSql = fs.readFileSync(projectSchemaPath, 'utf8');

		console.log('Applying core schema...');
		await pool.query(coreSchemaSql);
		console.log('Core schema applied successfully.');

		console.log('Applying project schema...');
		await pool.query(projectSchemaSql);
		console.log('Project schema applied successfully.');
	} catch (error) {
		console.error('Error applying schema:', error);
	} finally {
		await pool.end();
	}
}

applySchema();
