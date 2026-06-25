/**
 * CI-only: apply the SQL migrations to DATABASE_URL before the unit tests run.
 *
 * The CI "Unit tests" job uses a bare `pgvector` service container with no schema,
 * so the DB-backed tests (check / surfacing-store / agent-provenance / client-agent
 * / magic-acceptance) would hit `relation "workspaces" does not exist`. This applies
 * `supabase/migrations/*.sql` in filename order — exactly what docker-compose's
 * initdb mount does for the quickstart — using plain `pg` (already a dependency),
 * so no psql or build step is needed. The migrations were verified to contain no
 * CONCURRENTLY index builds or psql meta-commands, so one query() per file is safe.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url)); // <pkg>/test
const dir = path.resolve(here, "..", "..", "supabase", "migrations"); // <root>/supabase/migrations

if (!process.env.DATABASE_URL) {
  console.error("[ci-migrate] DATABASE_URL not set — nothing to do");
  process.exit(0);
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
for (const f of files) {
  await client.query(fs.readFileSync(path.join(dir, f), "utf8"));
}
await client.end();
console.log(`[ci-migrate] applied ${files.length} migration file(s)`);
