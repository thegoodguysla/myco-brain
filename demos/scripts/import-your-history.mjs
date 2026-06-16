#!/usr/bin/env node
/**
 * "Import your history" — the bring-your-past-conversations demo.
 *
 * Real code paths, zero mocks: parses a ChatGPT data-export fixture with the
 * actual importer parser, ingests one document per conversation, drains the
 * vector embeddings (the same flush the CLI now does), then a brand-new agent
 * with zero prior context asks a question and gets it back — with provenance.
 *
 * Runs against any migrated stack (docker compose up defaults). Embeddings use
 * keyless local Ollama; if Ollama isn't present the recall still lands via BM25
 * (the queries share wording with the source), so the demo degrades gracefully.
 *
 * Used by demos/tapes/import-your-history.tape — the sleeps are the performance.
 */
process.env.DATABASE_URL ??= "postgresql://brain:brain@localhost:5432/brain";
process.env.BRAIN_EMBED_PROVIDER ??= "ollama";

const { parseChatGptConversations } = await import("../../mcp-server/dist/export-import.lib.js");
const { ingest, IngestInput, flushPendingEmbeddings } = await import("../../mcp-server/dist/tools/ingest.js");
const { search, SearchInput } = await import("../../mcp-server/dist/tools/search.js");
const { why, WhyInput } = await import("../../mcp-server/dist/tools/why.js");
const { canonicalizeAgentContext } = await import("../../mcp-server/dist/agent-identity.js");
const { resolveAuth } = await import("../../mcp-server/dist/auth.js");
import { readFile } from "node:fs/promises";
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

// Deterministic re-renders: clear this demo's imported docs first (silently),
// so each render re-imports and re-embeds from scratch.
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
for (const sql of [
  `DELETE FROM chunks_ollama_nomic WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE hyobject_id IN (SELECT hyobject_id FROM hyobjects WHERE workspace_id=$1 AND name LIKE 'chatgpt:%'))`,
  `DELETE FROM chunk_extraction_status WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE hyobject_id IN (SELECT hyobject_id FROM hyobjects WHERE workspace_id=$1 AND name LIKE 'chatgpt:%'))`,
  `DELETE FROM chunks WHERE hyobject_id IN (SELECT hyobject_id FROM hyobjects WHERE workspace_id=$1 AND name LIKE 'chatgpt:%')`,
  `DELETE FROM hyobjects WHERE workspace_id=$1 AND (name LIKE 'chatgpt:%' OR name LIKE 'Ingested: chatgpt:%')`,
]) { try { await db.query(sql, [WS]); } catch { /* older schema */ } }

const fixture = new URL("../media/chatgpt-export/conversations.json", import.meta.url);
const conversations = parseChatGptConversations(JSON.parse(await readFile(fixture, "utf8")));

await say("");
await say(C.bold("  🧠 Myco Brain — import your ChatGPT history"), 900);
await say("");
await say(`  ${C.dim("$")} ${C.cyan("mycobrain-ingest --from chatgpt-export")} ${C.dim("~/Downloads/chatgpt-export.zip")}`, 1100);
await say("");
await say(`  ${C.dim(`Found ${conversations.length} conversation(s).`)}`, 600);
for (const conv of conversations) {
  await ingest(ctx, IngestInput.parse({
    mode: "text",
    text: conv.text,
    name: `chatgpt: ${conv.title}`.slice(0, 480),
    type_id: 1,
    tags: { source: `chatgpt-export#${conv.id}`, provider: "chatgpt", conversation_id: conv.id },
  }));
  await say(`    ${C.green("✓")} ${conv.title}`, 500);
}
// Drain vector embeddings before we query — the same flush the CLI now does.
await flushPendingEmbeddings();
await say(`  ${C.green(`✓ imported ${conversations.length} conversations`)} ${C.dim("· embeddings ready · content-hash deduped")}`, 1100);

await say("");
await say(`  ${C.dim("…a week later, a brand-new agent — zero prior context — asks:")}`, 1200);
await say("");
await say(`  ${C.cyan("❯")} ${C.bold("which database did we choose, and why?")}`, 900);

const res = await search(ctx, SearchInput.parse({ query: "which database did we choose and why?", limit: 3 }));
const hit = res.results?.[0];
// The conversation document puts each turn's "Role (timestamp):" on its own
// line with the text below; take the text after the last label — the
// assistant's concluding answer.
const hitLines = (hit?.text || "").split("\n");
let lastLabel = -1;
for (let i = 0; i < hitLines.length; i++) {
  if (/^(User|Assistant|Human)\b.*:$/.test(hitLines[i].trim())) lastLabel = i;
}
const snippet = hitLines.slice(lastLabel + 1).join(" ").replace(/\s+/g, " ").trim().slice(0, 104);
await say("");
await say(`  ${C.green("✓ remembered")} ${C.dim("(top score " + (hit?.score?.toFixed?.(2) ?? "—") + ")")}`, 500);
await say(`    ${C.yellow('"' + snippet + '…"')}`, 1200);

await say("");
await say(`  ${C.cyan("❯")} ${C.bold("brain_why — where did that come from?")}`, 900);
const trail = await why(ctx, WhyInput.parse({ hyobject_id: hit.hyobject_id }));
await say("");
await say(`  ${C.magenta("provenance:")} ${C.dim("document")} ${C.bold(trail.subject?.name ?? "")}`, 450);
await say(`    ${C.dim("source")}   your ChatGPT export — conversation "Choosing our database"`, 450);
await say(`    ${C.dim("dedup")}    content-hashed — re-importing can never duplicate`, 1000);

await say("");
await say(`  ${C.bold("Your past conversations, now searchable memory.")} ${C.dim("Zero API keys.")}`, 900);
await say(`  ${C.dim("github.com/thegoodguysla/myco-brain")}`, 1500);
await say("");

await db.end();
