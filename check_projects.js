require("dotenv").config();
const { pool } = require("./src/db");

async function checkProjects() {
  try {
    const res = await pool.query("SELECT project_id, project_name FROM projects ORDER BY project_id");
    console.log("Existing Projects:", res.rows);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

checkProjects();
