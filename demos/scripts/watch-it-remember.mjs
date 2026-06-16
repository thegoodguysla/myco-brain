#!/usr/bin/env node
/**
 * "Watch it remember" — the hero demo scenario.
 *
 * Real code paths, zero mocks: saves three memories from different "days",
 * asks a question, watches recall find the answer, then asks brain_why for
 * the provenance trail. Runs against any migrated stack (docker compose up
 * defaults); deterministic across re-renders (pre-cleans its own rows).
 *
 * Used by demos/tapes/watch-it-remember.tape — pacing sleeps are part of the
 * performance.
 */
process.env.DATABASE_URL ??= "postgresql://brain:brain@localhost:5432/brain";

const { canonicalizeAgentContext } = await import("../../mcp-server/dist/agent-identity.js");
const { resolveAuth } = await import("../../mcp-server/dist/auth.js");
const { ingest, IngestInput } = await import("../../mcp-server/dist/tools/ingest.js");
const { search, SearchInput } = await import("../../mcp-server/dist/tools/search.js");
const { why, WhyInput } = await import("../../mcp-server/dist/tools/why.js");
import { createRequire } from "node:module";
const require = createRequire(new URL("../../mcp-server/package.json", import.meta.url));
const pg = require("pg");

const WS = "00000000-0000-0000-0000-000000000001";
const AG = "00000000-0000-0000-0000-0000000000a1";
const { ctx: raw } = resolveAuth({ apiKey: `brain_${WS}_${AG}_localdev`, workspaceId: WS });
const ctx = await canonicalizeAgentContext(raw);

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = async (line, ms = 350) => { console.log(line); await sleep(ms); };

// Deterministic re-renders: clear this demo's rows first (silently).
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
for (const sql of [
  `DELETE FROM chunk_extraction_status WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE hyobject_id IN (SELECT hyobject_id FROM hyobjects WHERE workspace_id=$1 AND name LIKE 'demo-memory-%'))`,
  `DELETE FROM chunks_openai3small WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE hyobject_id IN (SELECT hyobject_id FROM hyobjects WHERE workspace_id=$1 AND name LIKE 'demo-memory-%'))`,
  `DELETE FROM chunks_ollama_nomic WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE hyobject_id IN (SELECT hyobject_id FROM hyobjects WHERE workspace_id=$1 AND name LIKE 'demo-memory-%'))`,
  `DELETE FROM chunks WHERE hyobject_id IN (SELECT hyobject_id FROM hyobjects WHERE workspace_id=$1 AND name LIKE 'demo-memory-%')`,
  `DELETE FROM hyobjects WHERE workspace_id=$1 AND name LIKE 'demo-memory-%'`,
]) { try { await db.query(sql, [WS]); } catch { /* older schema */ } }

const memories = [
  ["Monday",    "Kara prefers all deploys to staging first — she got burned by a hotfix in March."],
  ["Tuesday",   "The Helios project deadline moved to July 9 after the client call."],
  ["Wednesday", "Marcus owns the billing migration; loop him in on anything touching invoices."],
];

await say("");
await say(C.bold("  🧠 Myco Brain — watch it remember"), 900);
await say("");
for (const [day, text] of memories) {
  await ingest(ctx, IngestInput.parse({
    mode: "text", text, name: `demo-memory-${day.toLowerCase()}`,
    idempotency_key: `demo-${day}-${Date.now()}`, trace_id: `demo-${day}`,
    raw_payload: { demo: true },
  }));
  await say(`  ${C.dim(day + ":")} ${C.green("✓ saved")}  ${C.dim('"' + text.slice(0, 58) + '…"')}`, 650);
}
await say("");
await say(`  ${C.dim("…three days later, a different agent asks:")}`, 1100);
await say("");
await say(`  ${C.cyan("❯")} ${C.bold("when is the Helios deadline?")}`, 900);

const res = await search(ctx, SearchInput.parse({ query: "Helios project deadline", limit: 3 }));
const hit = res.results[0];
await say("");
await say(`  ${C.green("✓ remembered")} ${C.dim("(" + res.results.length + " matches, top score " + (hit.score?.toFixed?.(2) ?? "—") + ")")}`, 500);
await say(`    ${C.yellow('"' + hit.text.trim().slice(0, 64) + '"')}`, 1100);
await say("");
await say(`  ${C.cyan("❯")} ${C.bold("brain_why — where did that come from?")}`, 900);

const trail = await why(ctx, WhyInput.parse({ hyobject_id: hit.hyobject_id }));
await say("");
await say(`  ${C.magenta("provenance:")} ${C.dim("document")} ${C.bold(trail.subject?.name ?? "")}`, 450);
await say(`    ${C.dim("created")}  ${String(trail.subject?.created_at ?? "").slice(0, 19)}`, 450);
const vc = trail.vc_trail?.[0];
if (vc) await say(`    ${C.dim("audit")}    ${vc.operation} by ${C.bold(vc.actor_kind)} ${C.dim("(" + vc.actor_id.slice(0, 18) + "…)")}`, 450);
await say(`    ${C.dim("dedup")}    content-hashed — re-saving it can never duplicate`, 900);
await say("");
await say(`  ${C.bold("Every fact has a source. Nothing is ever silently overwritten.")}`, 800);
await say(`  ${C.dim("github.com/thegoodguysla/myco-brain · zero API keys required")}`, 1500);
await say("");

await db.end();
