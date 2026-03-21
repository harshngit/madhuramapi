const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
require('dotenv').config();

async function applySchema() {
	try {
		const schemaPath = path.join(__dirname, '../../db/attendance_schema.sql');
		const schemaSql = fs.readFileSync(schemaPath, 'utf8');

		// Split by semicolon but ignore ones inside strings or functions if any.
		// For this simple schema, splitting by semicolon is fine.
		const statements = schemaSql.split(';').map(s => s.trim()).filter(s => s.length > 0);

		console.log('Applying attendance schema statements...');
		for (const stmt of statements) {
			console.log(`Executing: ${stmt.substring(0, 50)}...`);
			await pool.query(stmt);
		}

		const res = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'attendance'");
		console.log('Columns in attendance table:', res.rows.map(r => r.column_name));

		console.log('Attendance schema applied successfully.');
	} catch (error) {
		console.error('Error applying attendance schema:', error);
	} finally {
		await pool.end();
	}
}

applySchema();
