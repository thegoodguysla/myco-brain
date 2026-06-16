#!/usr/bin/env node
/**
 * mycobrain-onboard — the frictionless first-run experience.
 *
 * Myco Brain ships EMPTY: a fresh install has zero memories. The fastest path
 * to the "whoa" moment is your OWN data, so this command leads with importing
 * your ChatGPT / Claude history, keeps "just start using it" one line away, and
 * offers an optional, sandboxed live tour for the curious — none of which
 * pollutes your real workspace.
 *
 *   mycobrain-onboard               guided getting-started (default)
 *   mycobrain-onboard --tour        ephemeral live walkthrough on sample data,
 *                                   then deletes itself (workspace left pristine)
 *   mycobrain-onboard --reset-demo  remove the bundled SAMPLE data (the
 *                                   examples/demo-corpus + demo memories) — your
 *                                   own imports are intentionally preserved
 *
 * Auth/connection default to the docker-compose quickstart stack; any of
 * DATABASE_URL / BRAIN_API_KEY / BRAIN_WORKSPACE_ID override.
 */
import "dotenv/config";
import type pg from "pg";
import { canonicalizeAgentContext } from "./agent-identity.js";
import { resolveAuth } from "./auth.js";
import { ingest, IngestInput } from "./tools/ingest.js";
import { search, SearchInput } from "./tools/search.js";
import { why, WhyInput } from "./tools/why.js";
import { withSession, closePool, type SessionContext } from "./db.js";

const LOCALDEV_DATABASE_URL = "postgresql://brain:brain@localhost:5432/brain";
const LOCALDEV_API_KEY =
  "brain_00000000-0000-0000-0000-000000000001_00000000-0000-0000-0000-0000000000a1_localdev";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function resolveContext(): Promise<SessionContext> {
  const auth = resolveAuth({
    apiKey: process.env.BRAIN_API_KEY ?? LOCALDEV_API_KEY,
    workspaceId: process.env.BRAIN_WORKSPACE_ID,
    agentId: process.env.BRAIN_AGENT_ID,
  });
  return canonicalizeAgentContext(auth.ctx, { rawApiKey: auth.rawKey });
}

// Run all DB work through withSession so the RLS context AND the audit-trigger
// GUCs (app.actor_kind, etc.) are set — a raw delete would trip the `vc` audit
// trigger's actor_kind check.
function session<T>(ctx: SessionContext, reason: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return withSession({ ...ctx, actorKind: "agent", reason }, fn);
}

// Count the user's recallable memories (documents/memories, not audit actions).
async function memoryCount(client: pg.PoolClient, workspaceId: string): Promise<number> {
  const res = await client.query(
    `SELECT count(*)::int AS n FROM hyobjects WHERE workspace_id = $1 AND type_id <> 80`,
    [workspaceId]
  );
  return res.rows[0]?.n ?? 0;
}

// ── default: guided getting-started ─────────────────────────────────────────
async function guide(ctx: SessionContext): Promise<void> {
  const n = await session(ctx, "onboard", (c) => memoryCount(c, ctx.workspaceId));
  console.log("");
  console.log(C.bold("  🧠 Myco Brain — getting started"));
  console.log("");
  console.log(
    n === 0
      ? `  ${C.dim("Your brain is empty — let's fix that. The fastest way to feel the")}`
      : `  ${C.dim(`Your brain holds ${n} memor${n === 1 ? "y" : "ies"}. To add more — the fastest way to feel the`)}`
  );
  console.log(`  ${C.dim("magic is on YOUR OWN data:")}`);
  console.log("");
  console.log(`  ${C.cyan("①")} ${C.bold("Import your ChatGPT or Claude history")} ${C.dim("(~30s)")}`);
  console.log(`     ${C.dim("ChatGPT:")} Settings → Data Controls → Export data, then`);
  console.log(`       ${C.green("mycobrain-ingest --from chatgpt-export ~/Downloads/<export>.zip")}`);
  console.log(`     ${C.dim("Claude:")}  Settings → Privacy → Export data, then`);
  console.log(`       ${C.green("mycobrain-ingest --from claude-export ~/Downloads/<export>.zip")}`);
  console.log(`     ${C.dim('Then ask your agent: "what did I discuss about <topic>?"')}`);
  console.log("");
  console.log(`  ${C.cyan("②")} ${C.bold("…or just start using it")} ${C.dim("— it remembers as you work.")}`);
  console.log(`     ${C.dim("Point your agent (Claude Code, Cursor, …) at the MCP server and go.")}`);
  console.log("");
  console.log(`  ${C.cyan("③")} ${C.bold("Curious first?")} ${C.dim("Take a 60-second live tour on sample data:")}`);
  console.log(`       ${C.green("mycobrain-onboard --tour")}`);
  console.log(`     ${C.dim("(runs in a throwaway sandbox; your workspace stays untouched)")}`);
  console.log("");
  console.log(`  ${C.dim("Loaded the sample data earlier and want a clean slate?")}`);
  console.log(`       ${C.green("mycobrain-onboard --reset-demo")}`);
  console.log("");
  const warn = await rlsBypassWarning(ctx);
  if (warn) {
    console.log(`  ${C.yellow("⚠")}  ${C.dim(warn)}`);
    console.log("");
  }
}

// ── --tour: ephemeral live walkthrough, then self-clean ─────────────────────
const TOUR_MEMORIES: Array<[string, string]> = [
  ["demo-memory-tour-mon", "Kara prefers all deploys to staging first — she got burned by a hotfix in March."],
  ["demo-memory-tour-tue", "The Helios project deadline moved to July 9 after the client call."],
  ["demo-memory-tour-wed", "Marcus owns the billing migration; loop him in on anything touching invoices."],
];

async function tour(ctx: SessionContext): Promise<void> {
  const say = async (line: string, ms = 350) => {
    console.log(line);
    await sleep(ms);
  };
  // Clean any prior tour rows first (idempotent re-runs).
  await session(ctx, "tour-clean", (c) => purgeByNameLike(c, ctx.workspaceId, "demo-memory-tour-%"));

  await say("");
  await say(C.bold("  🧠 Myco Brain — 60-second tour") + C.dim("  (sample data; self-cleans on exit)"), 700);
  await say("");
  for (const [name, text] of TOUR_MEMORIES) {
    await ingest(ctx, IngestInput.parse({ mode: "text", text, name, tags: { demo: "tour" } }));
    await say(`  ${C.green("✓ saved")}  ${C.dim('"' + text.slice(0, 60) + '…"')}`, 500);
  }
  await say("");
  await say(`  ${C.dim("…a different agent, days later, asks:")}`, 900);
  await say(`  ${C.cyan("❯")} ${C.bold("when is the Helios deadline?")}`, 800);
  const res = await search(ctx, SearchInput.parse({ query: "Helios project deadline", limit: 3 }));
  const hit = res.results?.[0];
  await say("");
  if (hit) {
    await say(`  ${C.green("✓ remembered")}`, 500);
    await say(`    ${C.yellow('"' + (hit.text || "").trim().slice(0, 64) + '"')}`, 900);
    await say(`  ${C.cyan("❯")} ${C.bold("brain_why — where did that come from?")}`, 800);
    const trail = await why(ctx, WhyInput.parse({ hyobject_id: hit.hyobject_id }));
    await say(`    ${C.magenta("provenance:")} ${C.bold(trail.subject?.name ?? "")} ${C.dim("· content-hashed, never silently overwritten")}`, 900);
  } else {
    await say(`  ${C.dim("(no embedding/index backend reachable — recall skipped)")}`, 400);
  }
  // Self-clean so the user's workspace is left exactly as it was.
  await session(ctx, "tour-clean", (c) => purgeByNameLike(c, ctx.workspaceId, "demo-memory-tour-%"));
  await say("");
  await say(`  ${C.dim("Tour cleared — your workspace is untouched.")} ${C.bold("Now do it with YOUR data:")}`, 600);
  await say(`    ${C.green("mycobrain-ingest --from chatgpt-export ~/Downloads/<export>.zip")}`, 1000);
  await say("");
}

// ── --reset-demo: remove the bundled SAMPLE data only ───────────────────────
async function resetDemo(ctx: SessionContext, confirmed: boolean): Promise<void> {
  const ws = ctx.workspaceId;
  // Bundled sample provenance ONLY: the watch-it-remember/tour memories
  // (hyobjects.name LIKE 'demo-memory-%') and the examples/demo-corpus directory
  // ingest (chunks.metadata->>'source' ends with '/examples/demo-corpus'). A
  // user's own ChatGPT/Claude import (name 'chatgpt:%'/'claude:%', source
  // 'chatgpt-export:%') is structurally excluded by both arms. To be safe even
  // against rarer collisions (a user memory literally named 'demo-memory-…', or
  // a folder at some path ending '/examples/demo-corpus'), this is a DRY RUN by
  // default — it lists what it would delete and only deletes with --yes.
  const targetSub = `(
      SELECT hyobject_id FROM hyobjects
        WHERE workspace_id = $1 AND name LIKE 'demo-memory-%'
      UNION
      SELECT DISTINCT hyobject_id FROM chunks
        WHERE workspace_id = $1 AND metadata->>'source' LIKE 'dir:%/examples/demo-corpus'
    )`;
  await session(ctx, "reset-demo", async (client) => {
    const rows = await client.query(
      `SELECT h.hyobject_id, h.name FROM hyobjects h WHERE h.hyobject_id IN ${targetSub}`,
      [ws]
    );
    const ids = rows.rows.map((r) => r.hyobject_id);
    if (ids.length === 0) {
      console.log(`No bundled sample data found in this workspace — nothing to reset.`);
      console.log(C.dim(`(Your own imports, if any, are never touched by --reset-demo.)`));
      return;
    }
    if (!confirmed) {
      console.log(`Would remove ${C.bold(String(ids.length))} bundled sample document(s):`);
      for (const r of rows.rows.slice(0, 20)) console.log(`  ${C.dim("·")} ${r.name}`);
      if (rows.rows.length > 20) console.log(`  ${C.dim(`… and ${rows.rows.length - 20} more`)}`);
      console.log("");
      console.log(`${C.yellow("Dry run — nothing deleted.")} Review the list, then run:`);
      console.log(`  ${C.green("mycobrain-onboard --reset-demo --yes")}`);
      return;
    }
    await purgeHyobjectIds(client, ids);
    await runTolerant(
      client,
      `DELETE FROM hyobjects WHERE workspace_id = $1 AND type_id = 80 AND name LIKE 'Ingested: demo-memory-%'`,
      [ws]
    );
    console.log(`${C.green("✓")} Removed ${ids.length} bundled sample document(s) from this workspace.`);
    console.log(C.dim(`Your own imports and memories were not touched.`));
  });
}

// Warn when connected on a role that BYPASSES RLS (the default `brain`
// superuser does). Harmless for a single-workspace local install, but it means
// workspace isolation is NOT enforced — surfaced so nobody exposes a
// multi-workspace / networked deployment on it unknowingly.
async function rlsBypassWarning(ctx: SessionContext): Promise<string | null> {
  try {
    return await session(ctx, "onboard", async (client) => {
      const r = await client.query(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      );
      const row = r.rows[0];
      if (row && (row.rolsuper || row.rolbypassrls)) {
        return `Connected as a superuser/BYPASSRLS role — workspace isolation is NOT enforced here. Fine for a single-workspace local install; use a NOSUPERUSER role (e.g. brain_app) for any multi-workspace or network-exposed deployment.`;
      }
      return null;
    });
  } catch {
    return null;
  }
}

async function purgeByNameLike(client: pg.PoolClient, workspaceId: string, like: string): Promise<void> {
  const idsRes = await client.query(
    `SELECT hyobject_id FROM hyobjects WHERE workspace_id = $1 AND name LIKE $2`,
    [workspaceId, like]
  );
  await purgeHyobjectIds(client, idsRes.rows.map((r) => r.hyobject_id));
  await runTolerant(
    client,
    `DELETE FROM hyobjects WHERE workspace_id = $1 AND type_id = 80 AND name LIKE 'Ingested: ' || $2`,
    [workspaceId, like]
  );
}

// Run a statement, tolerating "missing table/column" on older schemas.
async function runTolerant(client: pg.PoolClient, sql: string, params: unknown[]): Promise<void> {
  try {
    await client.query(sql, params);
  } catch (err) {
    if (!/relation .* does not exist|column .* does not exist/i.test((err as Error).message)) throw err;
  }
}

// Delete a FIXED set of hyobjects (by id) and every row that references them, in
// FK-safe order. `entities` rows are left as harmless orphans. Tolerates tables
// absent on older schemas. The closure was derived from the live FK graph
// (pg_constraint); a new dependent table means adding a line here. Taking ids as
// a stable array (not a subquery) is deliberate: the cascade deletes chunks, and
// some targets are only identifiable via their chunks.
async function purgeHyobjectIds(client: pg.PoolClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const T = `($1::uuid[])`; // the fixed target id array
  const chunkSub = `(SELECT chunk_id FROM chunks WHERE hyobject_id = ANY${T})`;
  const stmts = [
    // chunk-derived
    `DELETE FROM chunk_extraction_status WHERE chunk_id IN ${chunkSub}`,
    `DELETE FROM chunks_openai3small WHERE chunk_id IN ${chunkSub}`,
    `DELETE FROM chunks_ollama_nomic WHERE chunk_id IN ${chunkSub}`,
    `DELETE FROM relation_evidence WHERE evidence_chunk_id IN ${chunkSub}`,
    `DELETE FROM entity_mentions WHERE chunk_id IN ${chunkSub}`,
    // hyobject-derived
    `DELETE FROM relation_evidence WHERE evidence_hyobject_id = ANY${T}`,
    `DELETE FROM entity_mentions WHERE hyobject_id = ANY${T}`,
    `DELETE FROM entity_relations WHERE source_hyobject_id = ANY${T}`,
    `DELETE FROM proposed_entities WHERE source_hyobject_id = ANY${T}`,
    `DELETE FROM proposed_relations WHERE source_hyobject_id = ANY${T}`,
    `DELETE FROM schema_proposals WHERE source_hyobject_id = ANY${T}`,
    `DELETE FROM hyobject_permissions WHERE hyobject_id = ANY${T}`,
    `DELETE FROM hypeoplerelations WHERE hyobject_id = ANY${T} OR source_hyobject_id = ANY${T}`,
    `DELETE FROM peoplerelations WHERE source_hyobject_id = ANY${T}`,
    `DELETE FROM relatedhyperdocuments WHERE hyobject1_id = ANY${T} OR hyobject2_id = ANY${T}`,
    `DELETE FROM bug_reports_dedup WHERE fallback_hyobject_id = ANY${T}`,
    // claims self-reference: drop superseded_by pointers into the target set first
    `UPDATE claims SET superseded_by = NULL WHERE superseded_by IN (SELECT claim_id FROM claims WHERE source_hyobject_id = ANY${T})`,
    `DELETE FROM claims WHERE source_hyobject_id = ANY${T}`,
    // the chunks and the documents themselves
    `DELETE FROM chunks WHERE hyobject_id = ANY${T}`,
    `DELETE FROM hyobjects WHERE hyobject_id = ANY${T}`,
  ];
  for (const sql of stmts) await runTolerant(client, sql, [ids]);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL && !process.env.SUPABASE_DB_URL) {
    process.env.DATABASE_URL = LOCALDEV_DATABASE_URL;
  }
  const arg = process.argv[2];
  const ctx = await resolveContext();

  if (arg === "--tour") {
    await tour(ctx);
  } else if (arg === "--reset-demo") {
    await resetDemo(ctx, process.argv.includes("--yes"));
  } else if (!arg || arg === "--help" || arg === "-h") {
    await guide(ctx);
  } else {
    console.error(`Unknown option: ${arg}`);
    console.error(`Usage: mycobrain-onboard [--tour | --reset-demo]`);
    process.exit(1);
  }
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    const msg = (err as Error).message;
    console.error(`\nError: ${msg}`);
    if (/ECONNREFUSED|ENOTFOUND|terminat|timeout/i.test(msg)) {
      console.error(
        `Could not reach the database. Is the stack running?\n` +
          `  docker compose up -d   (from the myco-brain repo root)`
      );
    }
    await closePool().catch(() => {});
    process.exit(1);
  });
