import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const directory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required. Copy the API environment example and configure PostgreSQL.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
});
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS usms_schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const filename of files) {
    const existing = await pool.query("SELECT 1 FROM usms_schema_migrations WHERE filename = $1", [filename]);
    if (existing.rowCount) {
      console.log(`skip ${filename} (already applied)`);
      continue;
    }
    const sql = await readFile(join(directory, filename), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO usms_schema_migrations (filename) VALUES ($1)", [filename]);
      await client.query("COMMIT");
      console.log(`applied ${filename}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  console.log("USMS database migrations are up to date.");
} catch (error) {
  console.error("Database migration failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
