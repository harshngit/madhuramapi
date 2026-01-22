const { Client } = require("pg");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

async function init() {
  const dbConfig = {
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "postgres",
    host: process.env.PGHOST || "localhost",
    port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
    database: "postgres",
  };

  let targetDbName = "madhuram_backend";

  if (process.env.DATABASE_URL) {
    try {
      const url = new URL(process.env.DATABASE_URL);
      dbConfig.user = url.username;
      dbConfig.password = url.password;
      dbConfig.host = url.hostname;
      dbConfig.port = Number(url.port) || 5432;
      if (url.pathname && url.pathname.length > 1) {
        targetDbName = url.pathname.substring(1);
      }
    } catch (e) {
      console.log("Could not parse DATABASE_URL, using individual vars");
    }
  }

  console.log(`Target Database: ${targetDbName}`);
  console.log(`Connecting to postgres to check/create database...`);
  
  const client = new Client(dbConfig);

  try {
    await client.connect();
    const res = await client.query(`SELECT 1 FROM pg_database WHERE datname = '${targetDbName}'`);
    if (res.rowCount === 0) {
      console.log(`Database ${targetDbName} does not exist. Creating...`);
      await client.query(`CREATE DATABASE ${targetDbName}`);
      console.log(`Database ${targetDbName} created successfully.`);
    } else {
      console.log(`Database ${targetDbName} already exists.`);
    }
  } catch (err) {
    console.error("Error checking/creating database:", err);
    process.exit(1);
  } finally {
    await client.end();
  }

  console.log(`Connecting to ${targetDbName} to apply schema...`);
  dbConfig.database = targetDbName;
  const dbClient = new Client(dbConfig);

  try {
    await dbClient.connect();
    // schema is in ../db/schema.sql relative to src/init-db.js
    const schemaPath = path.join(__dirname, "../db/schema.sql");
    const schemaSql = fs.readFileSync(schemaPath, "utf8");
    
    console.log("Applying schema...");
    await dbClient.query(schemaSql);
    console.log("Schema applied successfully.");
  } catch (err) {
    console.error("Error applying schema:", err);
    process.exit(1);
  } finally {
    await dbClient.end();
  }
}

init();
