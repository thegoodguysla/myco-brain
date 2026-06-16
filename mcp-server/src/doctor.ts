#!/usr/bin/env node
/**
 * `mycobrain doctor` — one command that answers "is it working, and if not,
 * why?". Runs a preflight checklist over the things that actually break a
 * fresh setup: the database, the migrations, the workspace + key, and which
 * optional capabilities (semantic search, the knowledge graph) are switched
 * on. Prints a green/yellow/red checklist with the exact fix for each line.
 *
 * Zero-config: with no env set it checks the docker-compose quickstart stack,
 * the same defaults `mycobrain-ingest` uses. Exit code is non-zero only when
 * something is actually broken (red), not for optional features being off.
 */
import "dotenv/config";
import pg from "pg";
import { getEmbeddingProvider } from "./embed.js";

const LOCALDEV_DATABASE_URL = "postgresql://brain:brain@localhost:5432/brain";
const LOCALDEV_API_KEY =
  "brain_00000000-0000-0000-0000-000000000001_00000000-0000-0000-0000-0000000000a1_localdev";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

type Status = "ok" | "warn" | "fail";
const rows: { status: Status; label: string; detail: string; fix?: string }[] = [];
const add = (status: Status, label: string, detail: string, fix?: string) =>
  rows.push({ status, label, detail, fix });

async function main(): Promise<void> {
  const usingLocaldevDb = !process.env.DATABASE_URL && !process.env.SUPABASE_DB_URL;
  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || LOCALDEV_DATABASE_URL;
  const apiKey = process.env.BRAIN_API_KEY || LOCALDEV_API_KEY;
  const usingLocaldevKey = !process.env.BRAIN_API_KEY;

  // ── 1. Database reachable ──────────────────────────────────────────────────
  const client = new pg.Client({ connectionString: dbUrl });
  let connected = false;
  try {
    await client.connect();
    await client.query("SELECT 1");
    connected = true;
    add("ok", "Database", `reachable${usingLocaldevDb ? " (quickstart stack on localhost)" : ""}`);
  } catch (err) {
    add("fail", "Database", `cannot connect: ${(err as Error).message}`,
      usingLocaldevDb
        ? "Start the stack: docker compose up -d   (from the myco-brain repo root)"
        : "Check DATABASE_URL points at a running Postgres.");
  }

  if (connected) {
    // ── 2. Schema present (migrations applied) ───────────────────────────────
    try {
      const core = await client.query(
        `SELECT to_regclass('public.hyobjects') AS h, to_regclass('public.workspaces') AS w`
      );
      if (core.rows[0].h && core.rows[0].w) {
        add("ok", "Schema", "core tables present (migrations applied)");
      } else {
        add("fail", "Schema", "core tables missing — migrations have not run",
          "On the quickstart stack the migrations run automatically on first boot. " +
            "If you point at your own Postgres, apply supabase/migrations/*.sql.");
      }
    } catch (err) {
      add("fail", "Schema", `could not inspect: ${(err as Error).message}`);
    }

    // ── 3. Workspace + API key ───────────────────────────────────────────────
    const parts = apiKey.startsWith("brain_") ? apiKey.split("_") : [];
    const wsId = parts[1];
    if (!wsId) {
      add("fail", "API key", "BRAIN_API_KEY is not a brain_<workspace>_<agent>_<secret> key",
        "Set BRAIN_API_KEY (the quickstart key is in .env.example).");
    } else {
      try {
        const ws = await client.query(
          `SELECT status FROM workspaces WHERE workspace_id = $1`, [wsId]
        );
        if (ws.rowCount === 0) {
          add("fail", "Workspace", `key points at workspace ${wsId.slice(0, 8)}… which does not exist`,
            "Use a key whose workspace exists, or seed it (the quickstart seeds …0001).");
        } else if (ws.rows[0].status === "disabled") {
          add("fail", "Workspace", `workspace ${wsId.slice(0, 8)}… is disabled`);
        } else {
          add("ok", "Workspace", `${wsId.slice(0, 8)}… active${usingLocaldevKey ? " (quickstart key)" : ""}`);
        }
      } catch (err) {
        add("fail", "Workspace", `lookup failed: ${(err as Error).message}`);
      }
    }
  }

  // ── 4. Semantic search (embeddings provider) ───────────────────────────────
  const embed = getEmbeddingProvider();
  if (embed) {
    add("ok", "Semantic search", `on — ${embed.name} (${embed.dimension}d)`);
  } else {
    add("warn", "Semantic search", "off — full-text (BM25) search still works",
      "For keyless semantic search: install Ollama, `ollama pull nomic-embed-text`, " +
        "then set BRAIN_EMBED_PROVIDER=ollama. Or set BRAIN_OPENAI_API_KEY.");
  }

  // ── 5. Knowledge graph (extraction provider) ───────────────────────────────
  const forced = (process.env.BRAIN_EXTRACTION_PROVIDER ?? "").trim().toLowerCase();
  const hasAnthropic = !!process.env.BRAIN_ANTHROPIC_API_KEY;
  const ollamaBase = (process.env.BRAIN_OLLAMA_BASE_URL ?? "").trim();
  const graphProvider =
    forced === "anthropic" || (!forced && hasAnthropic)
      ? "anthropic"
      : forced === "ollama" || (!forced && ollamaBase)
        ? "ollama (local, keyless)"
        : null;
  if (graphProvider) {
    add("ok", "Knowledge graph", `on — extraction via ${graphProvider}`);
  } else {
    add("warn", "Knowledge graph", "off — content is searchable, but no entity graph is built",
      "For a keyless local graph: install Ollama, `ollama pull llama3.2:3b`, " +
        "then set BRAIN_OLLAMA_BASE_URL=http://localhost:11434. Or set BRAIN_ANTHROPIC_API_KEY.");
  }

  // ── 6. Review backlog (the curation queue) ─────────────────────────────────
  if (connected) {
    try {
      const parts = apiKey.startsWith("brain_") ? apiKey.split("_") : [];
      const wsId = parts[1];
      const q = await client.query<{ pe: string; pr: string; sp: string }>(
        `SELECT
           (SELECT count(*) FROM proposed_entities WHERE workspace_id=$1 AND state='pending') AS pe,
           (SELECT count(*) FROM proposed_relations WHERE workspace_id=$1 AND state='pending') AS pr,
           (SELECT count(*) FROM schema_proposals  WHERE workspace_id=$1 AND state='pending') AS sp`,
        [wsId]
      );
      const pe = Number(q.rows[0].pe), pr = Number(q.rows[0].pr), sp = Number(q.rows[0].sp);
      const total = pe + pr + sp;
      if (total === 0) {
        add("ok", "Review queue", "empty — nothing waiting for a decision");
      } else {
        add("warn", "Review queue",
          `${pe} entit${pe === 1 ? "y" : "ies"}, ${pr} relation(s), ${sp} new type(s) pending`,
          "These are novel items the extractor wasn't confident enough to auto-promote. " +
            "Review them with `mycobrain review`, or set BRAIN_SCHEMA_AUTO_PROMOTE=1 to " +
            "auto-promote corroborated new types going forward.");
      }
    } catch {
      // tables may not exist on an un-migrated DB — already reported above.
    }
  }

  if (connected) await client.end().catch(() => {});

  // ── Render ─────────────────────────────────────────────────────────────────
  const mark = (s: Status) =>
    s === "ok" ? C.green("✓") : s === "warn" ? C.yellow("!") : C.red("✗");
  console.log(`\n  ${C.bold("Myco Brain — doctor")}\n`);
  for (const r of rows) {
    console.log(`  ${mark(r.status)} ${C.bold(r.label.padEnd(16))} ${r.detail}`);
    if (r.fix && r.status !== "ok") console.log(`    ${C.dim("→ " + r.fix)}`);
  }
  const fails = rows.filter((r) => r.status === "fail").length;
  const warns = rows.filter((r) => r.status === "warn").length;
  console.log("");
  if (fails === 0 && warns === 0) {
    console.log(`  ${C.green("All systems go.")} Connect a client and start saving memories.\n`);
  } else if (fails === 0) {
    console.log(`  ${C.green("Core is healthy.")} ${warns} optional capabilit${warns === 1 ? "y is" : "ies are"} off (see above).\n`);
  } else {
    console.log(`  ${C.red(`${fails} blocking issue${fails === 1 ? "" : "s"}`)} — fix the ${C.red("✗")} line(s) above, then re-run \`mycobrain doctor\`.\n`);
  }
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`doctor failed unexpectedly: ${(err as Error).message}`);
  process.exit(1);
});
