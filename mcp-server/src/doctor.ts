#!/usr/bin/env node
/**
 * `mycobrain doctor` — one command that answers "is it working, and if not,
 * why?". It does not just check config (is an env var set?); for the local
 * Ollama path it actually probes the server, confirms the model is pulled, and
 * runs a real embed/generate, so a green line means it WORKS. Prints a
 * green/yellow/red checklist with the exact fix for each line.
 *
 *   mycobrain-doctor          report status
 *   mycobrain-doctor --fix    offer to pull any missing Ollama models
 *
 * Zero-config: with no env set it checks the docker-compose quickstart stack.
 * Exit code is non-zero only when something is actually broken (a red line).
 */
import "dotenv/config";
import { createInterface } from "node:readline";
import pg from "pg";
import { getEmbeddingProvider } from "./embed.js";
import {
  resolveOllamaBase,
  hasModel,
  resolveExtraction,
  probeOllama,
  liveEmbedOk,
  liveGenerateOk,
  ollamaCliPresent,
  pullModel,
  type OllamaProbe,
} from "./doctor-live.js";

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

// Models found missing on a reachable Ollama — `--fix` offers to pull these.
const missingModels = new Set<string>();
// Probe Ollama at most once per base URL (semantic + graph may share it).
let probeCache: { base: string; probe: OllamaProbe } | null = null;
async function probeOllamaOnce(base: string): Promise<OllamaProbe> {
  if (probeCache && probeCache.base === base) return probeCache.probe;
  const probe = await probeOllama(base);
  probeCache = { base, probe };
  return probe;
}

async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise<string>((res) => rl.question(`${question}[Y/n] `, res));
  rl.close();
  const a = ans.trim().toLowerCase();
  return a === "" || a === "y" || a === "yes";
}

async function main(): Promise<void> {
  const usingLocaldevDb = !process.env.DATABASE_URL && !process.env.SUPABASE_DB_URL;
  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || LOCALDEV_DATABASE_URL;
  const apiKey = process.env.BRAIN_API_KEY || LOCALDEV_API_KEY;
  const usingLocaldevKey = !process.env.BRAIN_API_KEY;
  const wsId = apiKey.startsWith("brain_") ? apiKey.split("_")[1] : undefined;

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
    if (!wsId) {
      add("fail", "API key", "BRAIN_API_KEY is not a brain_<workspace>_<agent>_<secret> key",
        "Set BRAIN_API_KEY (the quickstart key is in .env.example).");
    } else {
      try {
        const ws = await client.query(`SELECT status FROM workspaces WHERE workspace_id = $1`, [wsId]);
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

  // ── 4. Semantic search (embeddings) — LIVE-verified for the Ollama path ─────
  const embed = getEmbeddingProvider();
  if (!embed) {
    add("warn", "Semantic search", "off — full-text (BM25) search still works",
      "Keyless: install Ollama, `ollama pull nomic-embed-text`, then set " +
        "BRAIN_EMBED_PROVIDER=ollama and BRAIN_OLLAMA_BASE_URL=http://localhost:11434. Or set BRAIN_OPENAI_API_KEY.");
  } else if (embed.name === "ollama") {
    const base = resolveOllamaBase();
    const model = process.env.BRAIN_OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
    const probe = await probeOllamaOnce(base);
    if (!probe.reachable) {
      add("fail", "Semantic search", `configured (ollama) but Ollama is not reachable at ${base}`,
        ollamaCliPresent()
          ? "Start it: `ollama serve` (or `brew services start ollama`), then re-run `mycobrain-doctor`."
          : "Install Ollama (https://ollama.com), then `ollama serve`.");
    } else if (!hasModel(probe.models, model)) {
      missingModels.add(model);
      add("fail", "Semantic search", `Ollama is up but the embed model '${model}' is not pulled`,
        `Pull it: \`ollama pull ${model}\`  — or run \`mycobrain-doctor --fix\`.`);
    } else if (!(await liveEmbedOk(base, model))) {
      add("fail", "Semantic search", `Ollama up and '${model}' present, but a test embedding failed`,
        `Check Ollama: \`ollama run ${model}\`, then re-run.`);
    } else {
      add("ok", "Semantic search", `on — ollama ${model} (${embed.dimension}d), live-verified`);
    }
  } else {
    add("ok", "Semantic search", `on — openai (${embed.dimension}d)`);
  }

  // ── 5. Knowledge graph (extraction) — LIVE-verified for the Ollama path ─────
  const ex = resolveExtraction();
  if (ex.provider === "none") {
    add("warn", "Knowledge graph",
      "off — content is searchable, but no entity graph is built (the extractor falls back to a no-op)",
      "Keyless local graph: install Ollama, `ollama pull llama3.2:3b`, then set " +
        "BRAIN_OLLAMA_BASE_URL=http://localhost:11434. Or set BRAIN_ANTHROPIC_API_KEY.");
  } else if (ex.provider === "anthropic") {
    add("ok", "Knowledge graph", "on — extraction via anthropic");
  } else {
    const probe = await probeOllamaOnce(ex.ollamaBase);
    if (!probe.reachable) {
      add("fail", "Knowledge graph", `configured (ollama) but Ollama is not reachable at ${ex.ollamaBase}`,
        ollamaCliPresent()
          ? "Start it: `ollama serve`, then re-run `mycobrain-doctor`."
          : "Install Ollama (https://ollama.com), then `ollama serve`.");
    } else if (!hasModel(probe.models, ex.model)) {
      missingModels.add(ex.model);
      add("fail", "Knowledge graph", `Ollama is up but the extraction model '${ex.model}' is not pulled`,
        `Pull it: \`ollama pull ${ex.model}\`  — or run \`mycobrain-doctor --fix\`.`);
    } else if (!(await liveGenerateOk(ex.ollamaBase, ex.model))) {
      add("fail", "Knowledge graph", `Ollama up and '${ex.model}' present, but a test generation failed`,
        `Check Ollama: \`ollama run ${ex.model}\`, then re-run.`);
    } else {
      add("ok", "Knowledge graph", `on — ollama ${ex.model}, live-verified`);
    }
  }

  // ── 5b. Extraction backlog (is the graph actually being built?) ────────────
  if (connected) {
    try {
      const r = await client.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM chunk_extraction_status WHERE workspace_id = $1 AND status = 'pending'`,
        [wsId]
      );
      const pending = Number(r.rows[0]?.n ?? 0);
      if (pending > 0 && ex.provider === "none") {
        add("warn", "Extraction backlog",
          `${pending} chunk(s) queued but no real extractor is configured — the graph will not build`,
          "Enable an extractor (see Knowledge graph above); the worker then drains the backlog.");
      } else if (pending > 50) {
        add("warn", "Extraction backlog", `${pending} chunk(s) waiting — the extraction worker may be stopped`,
          "Confirm the extraction-worker service is running (docker compose ps), or run `npm run worker:extract`.");
      } else {
        add("ok", "Extraction backlog", pending === 0 ? "clear — nothing waiting to extract" : `${pending} chunk(s) processing`);
      }
    } catch {
      // chunk_extraction_status may not exist on an older schema — skip quietly.
    }
  }

  // ── 6. Review backlog (the curation queue) ─────────────────────────────────
  if (connected) {
    try {
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
  const mark = (s: Status) => (s === "ok" ? C.green("✓") : s === "warn" ? C.yellow("!") : C.red("✗"));
  console.log(`\n  ${C.bold("Myco Brain — doctor")}\n`);
  for (const r of rows) {
    console.log(`  ${mark(r.status)} ${C.bold(r.label.padEnd(18))} ${r.detail}`);
    if (r.fix && r.status !== "ok") console.log(`    ${C.dim("→ " + r.fix)}`);
  }
  const fails = rows.filter((r) => r.status === "fail").length;
  const warns = rows.filter((r) => r.status === "warn").length;
  console.log("");
  if (fails === 0 && warns === 0) {
    console.log(`  ${C.green("All systems go.")} Connect a client and start feeding it sources.\n`);
  } else if (fails === 0) {
    console.log(`  ${C.green("Core is healthy.")} ${warns} optional capabilit${warns === 1 ? "y is" : "ies are"} off (see above).\n`);
  } else {
    console.log(`  ${C.red(`${fails} blocking issue${fails === 1 ? "" : "s"}`)} — fix the ${C.red("✗")} line(s) above, then re-run \`mycobrain-doctor\`.\n`);
  }

  // ── --fix: offer to pull any missing Ollama models ─────────────────────────
  if (process.argv.includes("--fix") && missingModels.size > 0) {
    console.log(`  ${C.bold("Fix")} — ${missingModels.size} model(s) can be pulled now:\n`);
    for (const model of missingModels) {
      const yes = await promptYesNo(`  Pull ${C.bold(model)} now? `);
      if (yes) {
        const ok = pullModel(model);
        console.log(ok ? `  ${C.green("✓")} pulled ${model}` : `  ${C.red("✗")} pull failed for ${model}`);
      }
    }
    console.log(`\n  Re-run ${C.green("mycobrain-doctor")} to confirm everything is green.\n`);
  } else if (missingModels.size > 0) {
    console.log(`  ${C.dim("Tip:")} ${C.green("mycobrain-doctor --fix")} ${C.dim("pulls the missing model(s) for you.")}\n`);
  }

  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`doctor failed unexpectedly: ${(err as Error).message}`);
  process.exit(1);
});
