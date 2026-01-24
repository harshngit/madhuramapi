const { pool } = require('../db');
require('dotenv').config();

async function alterTable() {
    try {
        console.log('Altering product_duration column type...');
        await pool.query('ALTER TABLE projects ALTER COLUMN product_duration TYPE DATE USING product_duration::DATE');
        console.log('Column altered successfully.');
    } catch (error) {
        console.error('Error altering column:', error);
    } finally {
        await pool.end();
    }
}

alterTable();
