require("dotenv").config();
const { pool } = require("./src/db");
const fs = require("fs");
const path = require("path");

async function initDB() {
  try {
    const sql = fs.readFileSync(path.join(__dirname, "db/project_schema.sql"), "utf8");
    await pool.query(sql);
    console.log("Database schema initialized successfully.");
  } catch (error) {
    console.error("Error initializing database:", error);
  } finally {
    pool.end();
  }
}

initDB();
