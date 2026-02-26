const { pool } = require('../db');
require('dotenv').config();

(async () => {
  try {
    const existsRes = await pool.query(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='delivery_challans') AS exists"
    );
    console.log('delivery_challans exists:', existsRes.rows[0].exists);

    const tablesRes = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('projects','pos','auth_users','boqs','mirs','itrs') ORDER BY table_name"
    );
    console.log('tables present:', tablesRes.rows.map(x => x.table_name));
  } catch (e) {
    console.error('Error checking tables:', e);
  } finally {
    await pool.end();
  }
})();
