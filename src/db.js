const { Pool } = require("pg");

const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false,
};

if (process.env.PGHOST) poolConfig.host = process.env.PGHOST;
if (process.env.PGPORT) poolConfig.port = Number(process.env.PGPORT);
if (process.env.PGUSER) poolConfig.user = process.env.PGUSER;
if (process.env.PGPASSWORD) poolConfig.password = process.env.PGPASSWORD;
if (process.env.PGDATABASE) poolConfig.database = process.env.PGDATABASE;

const pool = new Pool(poolConfig);

module.exports = { pool };
