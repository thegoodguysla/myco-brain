/**
 * Standalone migration runner — used by Railway (and Docker Compose users) to apply
 * the SQL migrations from ../supabase/migrations before the server starts.
 *
 * Tracks applied migrations in _myco_migrations so re-runs are safe.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error("[migrate] DATABASE_URL not set — aborting");
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
  });

  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS _myco_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  const migrationsDir = path.resolve(__dirname, "../migrations");
  if (!fs.existsSync(migrationsDir)) {
    console.log("[migrate] No migrations directory found — skipping");
    await client.end();
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const { rows: applied } = await client.query(
    "SELECT name FROM _myco_migrations"
  );
  const appliedSet = new Set(applied.map((r: { name: string }) => r.name));

  let count = 0;
  for (const file of files) {
    if (appliedSet.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    console.log(`[migrate] applying ${file}`);
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO _myco_migrations (name) VALUES ($1)",
        [file]
      );
      await client.query("COMMIT");
      count++;
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`[migrate] FAILED on ${file}:`, err);
      await client.end();
      process.exit(1);
    }
  }

  console.log(`[migrate] done — ${count} new migration(s) applied`);
  await client.end();
}

run().catch((err) => {
  console.error("[migrate] unexpected error:", err);
  process.exit(1);
});
