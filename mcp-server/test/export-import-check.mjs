#!/usr/bin/env node
/**
 * ChatGPT/Claude export-importer check — GATED on a database, no LLM.
 *
 *   1. builds a synthetic ChatGPT export (conversations.json) + a Claude one
 *   2. `mycobrain-ingest --from chatgpt-export` imports 2 conversations
 *   3. re-running imports 0 (content-hash dedup — re-imports are safe)
 *   4. brain_why on an imported doc traces back to the export file via tags
 *   5. the Claude path imports its conversation too
 *
 * Run-scoped content; cleans up after itself. Skips (exit 0) when
 * DATABASE_URL is unset — checked BEFORE dist/ imports.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (!process.env.DATABASE_URL) {
  console.log("[skip] export-import check — DATABASE_URL is not set.");
  process.exit(0);
}

const [{ canonicalizeAgentContext }, { resolveAuth },
       { why, WhyInput }, { default: pg }] = await Promise.all([
  import("../dist/agent-identity.js"),
  import("../dist/auth.js"),
  import("../dist/tools/why.js"),
  import("pg"),
]);

const WS = "00000000-0000-0000-0000-000000000001";
const AG = "00000000-0000-0000-0000-0000000000a1";
const API_KEY = `brain_${WS}_${AG}_localdev`;
const { ctx: raw } = resolveAuth({ apiKey: API_KEY, workspaceId: WS });
const ctx = await canonicalizeAgentContext(raw);

const run = `${Date.now()}`;
let failed = 0;
const ok = (m) => console.log(`ok    ${m}`);
const fail = (m) => { failed++; console.error(`FAIL  ${m}`); };
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

// ── 1. Synthetic exports ────────────────────────────────────────────────────
const dir = mkdtempSync(path.join(tmpdir(), "myco-export-"));
const msg = (id, parent, role, text, t) => ({
  id, parent, message: { author: { role }, content: { parts: [text] }, create_time: t },
});
const chatgpt = [
  {
    id: `cg-1-${run}`, title: `Quarterly forecast ${run}`,
    create_time: 1750000000, current_node: "n2",
    mapping: {
      n1: msg("n1", null, "user", `What drove the Q3 dip? (ref ${run})`, 1750000000),
      n2: msg("n2", "n1", "assistant", "Mostly the delayed Helios launch and FX headwinds.", 1750000100),
    },
  },
  {
    id: `cg-2-${run}`, title: `Standup notes ${run}`,
    create_time: 1750001000, current_node: "m2",
    mapping: {
      m1: msg("m1", null, "user", `Summarize today's standup (ref ${run})`, 1750001000),
      m2: msg("m2", "m1", "assistant", "Kara ships the billing fix; Marcus reviews.", 1750001100),
    },
  },
];
const claude = [{
  uuid: `cl-1-${run}`, name: `Logo feedback ${run}`,
  created_at: "2026-06-01T10:00:00Z",
  chat_messages: [
    { sender: "human", text: `Thoughts on the mushroom logo? (ref ${run})` },
    { sender: "assistant", content: [{ type: "text", text: "The cap silhouette reads well at 16px." }] },
  ],
}];
writeFileSync(path.join(dir, "chatgpt-conversations.json"), JSON.stringify(chatgpt));
writeFileSync(path.join(dir, "claude-conversations.json"), JSON.stringify(claude));
ok("synthetic exports written");

const cli = (args) =>
  execFileSync(process.execPath, [path.resolve("dist/ingest-cli.js"), ...args], {
    env: { ...process.env, BRAIN_API_KEY: API_KEY, BRAIN_WORKSPACE_ID: WS },
  }).toString();

// ── 2. First import: 2 conversations ───────────────────────────────────────
let out = cli(["--from", "chatgpt-export", path.join(dir, "chatgpt-conversations.json")]);
if (/2 conversation\(s\) ingested, 0 already known/.test(out)) {
  ok("chatgpt-export: 2 conversations ingested");
} else {
  fail(`unexpected first-import output: ${out.trim().split("\n").pop()}`);
}

// ── 3. Re-import: dedup makes it a no-op ───────────────────────────────────
out = cli(["--from", "chatgpt-export", path.join(dir, "chatgpt-conversations.json")]);
if (/0 conversation\(s\) ingested, 2 already known/.test(out)) {
  ok("re-import deduped: 0 ingested, 2 already known");
} else {
  fail(`re-import not deduped: ${out.trim().split("\n").pop()}`);
}

// ── 4. brain_why traces an imported fact to its export file ────────────────
const doc = (await db.query(
  `SELECT hyobject_id FROM hyobjects WHERE workspace_id = $1 AND name = $2`,
  [WS, `chatgpt: Quarterly forecast ${run}`]
)).rows[0];
if (!doc) {
  fail("imported document not found by name");
} else {
  const trail = await why(ctx, WhyInput.parse({ hyobject_id: doc.hyobject_id }));
  // tags persist into chunks.metadata (jsonb) — the searchable provenance.
  const meta = (await db.query(
    `SELECT metadata FROM chunks WHERE hyobject_id = $1 LIMIT 1`, [doc.hyobject_id]
  )).rows[0]?.metadata ?? {};
  const source = meta.source ?? "";
  if (trail.subject?.id === doc.hyobject_id &&
      String(source).includes("chatgpt-export:chatgpt-conversations.json#cg-1-")) {
    ok(`brain_why + tags trace to the export file: ${source}`);
  } else {
    fail(`provenance missing: subject=${trail.subject?.id} source=${source}`);
  }
}

// ── 5. Claude path ──────────────────────────────────────────────────────────
out = cli(["--from", "claude-export", path.join(dir, "claude-conversations.json")]);
if (/1 conversation\(s\) ingested, 0 already known/.test(out)) {
  ok("claude-export: 1 conversation ingested");
} else {
  fail(`claude import failed: ${out.trim().split("\n").pop()}`);
}

// ── 6. Robustness: friendly failures, not crashes ──────────────────────────
const cliTry = (args) => {
  try {
    return { ok: true, out: cli(args) };
  } catch (e) {
    return { ok: false, out: `${(e.stdout || "").toString()}${(e.stderr || "").toString()}` };
  }
};

// malformed JSON → guided error, not a raw SyntaxError
writeFileSync(path.join(dir, "broken.json"), "{ not valid json");
let r = cliTry(["--from", "chatgpt-export", path.join(dir, "broken.json")]);
if (!r.ok && /doesn't look like a chatgpt-export/.test(r.out)) {
  ok("malformed JSON fails with a guided 'not an export' message");
} else {
  fail(`malformed JSON not handled: ${r.out.trim().split("\n").pop()}`);
}

// folder without conversations.json → guided error
r = cliTry(["--from", "chatgpt-export", dir]);
if (!r.ok && /No conversations\.json in that folder/.test(r.out)) {
  ok("folder missing conversations.json fails with guidance");
} else {
  fail(`missing conversations.json not handled: ${r.out.trim().split("\n").pop()}`);
}

// valid-but-empty export → clean no-op, not an error
writeFileSync(path.join(dir, "empty.json"), "[]");
r = cliTry(["--from", "chatgpt-export", path.join(dir, "empty.json")]);
if (r.ok && /No conversations found/.test(r.out)) {
  ok("empty export is a clean no-op with a clear message");
} else {
  fail(`empty export not handled cleanly: ${r.out.trim().split("\n").pop()}`);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
const names = [`chatgpt: Quarterly forecast ${run}`, `chatgpt: Standup notes ${run}`, `claude: Logo feedback ${run}`];
for (const sql of [
  `DELETE FROM chunk_extraction_status WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE hyobject_id IN (SELECT hyobject_id FROM hyobjects WHERE workspace_id=$1 AND name = ANY($2)))`,
  `DELETE FROM chunks_openai3small WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE hyobject_id IN (SELECT hyobject_id FROM hyobjects WHERE workspace_id=$1 AND name = ANY($2)))`,
  `DELETE FROM chunks_ollama_nomic WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE hyobject_id IN (SELECT hyobject_id FROM hyobjects WHERE workspace_id=$1 AND name = ANY($2)))`,
  `DELETE FROM chunks WHERE hyobject_id IN (SELECT hyobject_id FROM hyobjects WHERE workspace_id=$1 AND name = ANY($2))`,
  `DELETE FROM hyobjects WHERE workspace_id=$1 AND name = ANY($2)`,
]) { try { await db.query(sql, [WS, names]); } catch { /* older schema */ } }
rmSync(dir, { recursive: true, force: true });

await db.end();
console.log(`\n=== ${failed === 0 ? "PASS" : "FAIL"} (export-import) ===`);
process.exit(failed === 0 ? 0 : 1);
