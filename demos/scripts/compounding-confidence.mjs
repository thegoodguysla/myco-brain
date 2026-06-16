#!/usr/bin/env node
/**
 * Compounding confidence — the marquee demo (Rhea Calloway lifecycle).
 *
 * Real engine, zero mocks: the same rescoreEntityRelation /
 * supersedeContradictedRelations code paths that `npm run test:compounding`
 * verifies, performed with visible pacing. Corroboration RAISES confidence;
 * a confident contradiction SUPERSEDES (closes + weakens — never overwrites);
 * the claims ledger keeps the history. Deterministic: pre-cleans and
 * post-cleans its synthetic rows.
 */
process.env.DATABASE_URL ??= "postgresql://brain:brain@localhost:5432/brain";

const { canonicalizeAgentContext } = await import("../../mcp-server/dist/agent-identity.js");
const { resolveAuth } = await import("../../mcp-server/dist/auth.js");
const { withSession } = await import("../../mcp-server/dist/db.js");
const { rescoreEntityRelation } = await import("../../mcp-server/dist/confidence.js");
const { supersedeContradictedRelations } = await import("../../mcp-server/dist/contradiction.js");
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
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = async (line, ms = 380) => { console.log(line); await sleep(ms); };
const bar = (c) => {
  const filled = Math.round(c * 22);
  return C.dim("[") + C.green("█".repeat(filled)) + C.dim("░".repeat(22 - filled) + "]") + ` ${C.bold(c.toFixed(2))}`;
};

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const clean = async (ids) => {
  if (!ids.person) return;
  await db.query(`DELETE FROM relation_evidence WHERE source_node_id = $1`, [ids.person]);
  await db.query(`DELETE FROM claims WHERE workspace_id = $1 AND subject_id = $2`, [WS, ids.person]);
  await db.query(`DELETE FROM entity_relations WHERE workspace_id = $1 AND entity1_id = $2`, [WS, ids.person]);
  await db.query(`DELETE FROM entities WHERE entity_id = ANY($2::uuid[]) AND workspace_id = $1`, [WS, [ids.person, ids.orgA, ids.orgB].filter(Boolean)]);
};
// pre-clean any leftovers from a prior render
const prior = await db.query(`SELECT entity_id FROM entities WHERE workspace_id=$1 AND canonical_name IN ('Rhea Calloway','Halcyon Labs (demo)','Driftwood Analytics (demo)')`, [WS]);
for (const r of prior.rows) await clean({ person: r.entity_id });
await db.query(`DELETE FROM entities WHERE workspace_id=$1 AND canonical_name IN ('Rhea Calloway','Halcyon Labs (demo)','Driftwood Analytics (demo)')`, [WS]);

const ids = {};
await withSession(ctx, async (client) => {
  const ent = async (name) => (await client.query(
    `INSERT INTO entities (workspace_id, kind_id, canonical_name, aliases) VALUES ($1, 2, $2, $3) RETURNING entity_id`,
    [WS, name, []])).rows[0].entity_id;
  ids.person = await ent("Rhea Calloway");
  ids.orgA = await ent("Halcyon Labs (demo)");
  ids.orgB = await ent("Driftwood Analytics (demo)");
  ids.docs = (await client.query(`SELECT hyobject_id FROM hyobjects WHERE workspace_id=$1 LIMIT 2`, [WS])).rows.map((r) => r.hyobject_id);
});

const evidence = (client, edge, doc, conf) => client.query(
  `INSERT INTO relation_evidence (workspace_id, relation_kind, relation_row_id, source_node_id, target_node_id, predicate, evidence_hyobject_id, confidence, evidence_kind)
   VALUES ($1,'entity_relation',$2,$3,$4,'works for',$5,$6,'extraction')`,
  [WS, edge, ids.person, ids.orgA, doc, conf]);

await say("");
await say(C.bold("  🧠 Myco Brain — confidence that compounds"), 1000);
await say("");
await say(`  ${C.dim("source #1 says:")} "Rhea Calloway works for Halcyon Labs"`, 700);

let edge;
await withSession(ctx, async (client) => {
  edge = (await client.query(
    `INSERT INTO entity_relations (workspace_id, entity1_id, entity2_id, predicate, source_hyobject_id, confidence)
     VALUES ($1,$2,$3,'works for',$4,0.8) RETURNING id`, [WS, ids.person, ids.orgA, ids.docs[0]])).rows[0].id;
  await evidence(client, edge, ids.docs[0], 0.8);
  await rescoreEntityRelation(client, WS, ids.person, ids.orgA, "works for");
});
await say(`  ${C.dim("confidence")}  ${bar(0.8)}`, 1100);
await say("");
await say(`  ${C.dim("an independent source agrees:")} "Rhea is at Halcyon"`, 700);

let rise;
await withSession(ctx, async (client) => {
  await evidence(client, edge, ids.docs[1], 0.7);
  rise = await rescoreEntityRelation(client, WS, ids.person, ids.orgA, "works for");
});
await say(`  ${C.dim("confidence")}  ${bar(rise.confidence)}  ${C.green("▲ rises — 2 independent sources")}`, 1300);
await say("");
await say(`  ${C.yellow("then a confident new source contradicts:")}`, 600);
await say(`  "Rhea Calloway works for ${C.bold("Driftwood Analytics")}"`, 900);

await withSession(ctx, async (client) => {
  await supersedeContradictedRelations(client, WS, ids.person, "works for", ids.orgB, 0.9, ids.docs[1], "demo");
  await client.query(
    `INSERT INTO entity_relations (workspace_id, entity1_id, entity2_id, predicate, source_hyobject_id, confidence)
     VALUES ($1,$2,$3,'works for',$4,0.9)`, [WS, ids.person, ids.orgB, ids.docs[1]]);
});
const state = await db.query(
  `SELECT e2.canonical_name AS org, round(er.confidence,2) AS conf, er.valid_to IS NULL AS active
     FROM entity_relations er JOIN entities e2 ON e2.entity_id = er.entity2_id
    WHERE er.workspace_id=$1 AND er.entity1_id=$2 ORDER BY er.created_at`, [WS, ids.person]);
await say("");
for (const r of state.rows) {
  const label = r.active ? C.green("[ACTIVE]") : C.red("[SUPERSEDED — kept, not deleted]");
  await say(`  works for → ${C.bold(r.org.replace(" (demo)", ""))}  ${C.dim(String(r.conf))}  ${label}`, 800);
}
const chain = await db.query(
  `SELECT count(*)::int AS n FROM claims WHERE workspace_id=$1 AND subject_id=$2 AND superseded_by IS NOT NULL`, [WS, ids.person]);
await say("");
await say(`  ${C.dim("claims ledger:")} old fact ${C.red("superseded_by")} → new fact ${C.dim("(" + chain.rows[0].n + " chain link, audited)")}`, 900);
await say("");
await say(`  ${C.bold("Contradictions are visible — never silent.")}`, 800);
await say(`  ${C.dim("verify it yourself: npm run test:compounding")}`, 1500);
await say("");

await clean(ids);
await db.end();
