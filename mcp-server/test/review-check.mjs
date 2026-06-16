#!/usr/bin/env node
/**
 * `mycobrain review` curation check — GATED on a database, no LLM.
 *
 * Seeds one pending proposal of each kind (entity, relationship, schema type),
 * runs the real review CLI, and proves each one actually lands in the
 * canonical graph / catalog (not just a state flip):
 *   - approve entity  → row in entities + entity_mentions, proposal 'approved'
 *   - approve type    → row in entity_kinds catalog, proposal 'approved'
 *   - approve relation→ edge in entity_relations, proposal 'approved'
 *   - reject          → proposal 'rejected' (kept, audited)
 *
 * Run-scoped; cleans up after itself. Skips (exit 0) when DATABASE_URL unset.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

if (!process.env.DATABASE_URL) {
  console.log("[skip] review check — DATABASE_URL is not set.");
  process.exit(0);
}

const { default: pg } = await import("pg");
const WS = "00000000-0000-0000-0000-000000000001";
const API_KEY = `brain_${WS}_00000000-0000-0000-0000-0000000000a1_localdev`;
const run = `${Date.now()}`;
let failed = 0;
const ok = (m) => console.log(`ok    ${m}`);
const fail = (m) => { failed++; console.error(`FAIL  ${m}`); };

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const KIND_NAME = `reviewprobe-kind-${run}`;
const REL_PRED = `reviewprobe-rel-${run}`;
const E1_NAME = `ReviewProbe Subject ${run}`;
const E2_NAME = `ReviewProbe Object ${run}`;
const PE_NAME = `ReviewProbe Entity ${run}`;
const PE_REJECT_NAME = `ReviewProbe Reject ${run}`;

const hyobj = (await db.query(`SELECT hyobject_id FROM hyobjects WHERE workspace_id=$1 LIMIT 1`, [WS])).rows[0].hyobject_id;

const cleanup = async () => {
  await db.query(`DELETE FROM entity_mentions WHERE workspace_id=$1 AND entity_id IN (SELECT entity_id FROM entities WHERE workspace_id=$1 AND canonical_name = ANY($2))`, [WS, [E1_NAME, E2_NAME, PE_NAME]]).catch(()=>{});
  await db.query(`DELETE FROM entity_relations WHERE workspace_id=$1 AND predicate=$2`, [WS, REL_PRED]).catch(()=>{});
  await db.query(`DELETE FROM proposed_relations WHERE workspace_id=$1 AND predicate=$2`, [WS, REL_PRED]).catch(()=>{});
  await db.query(`DELETE FROM proposed_entities WHERE workspace_id=$1 AND canonical_name = ANY($2)`, [WS, [PE_NAME, PE_REJECT_NAME]]).catch(()=>{});
  await db.query(`DELETE FROM schema_proposals WHERE workspace_id=$1 AND name=$2`, [WS, KIND_NAME]).catch(()=>{});
  await db.query(`DELETE FROM entities WHERE workspace_id=$1 AND canonical_name = ANY($2)`, [WS, [E1_NAME, E2_NAME, PE_NAME]]).catch(()=>{});
  await db.query(`DELETE FROM entity_kinds WHERE name=$1`, [KIND_NAME]).catch(()=>{});
};
await cleanup();

// ── Seed: two canonical entities + one pending proposal of each type ─────────
const e1 = (await db.query(`INSERT INTO entities (workspace_id, kind_id, canonical_name, aliases) VALUES ($1,2,$2,'{}') RETURNING entity_id`, [WS, E1_NAME])).rows[0].entity_id;
const e2 = (await db.query(`INSERT INTO entities (workspace_id, kind_id, canonical_name, aliases) VALUES ($1,2,$2,'{}') RETURNING entity_id`, [WS, E2_NAME])).rows[0].entity_id;
const peId = (await db.query(
  `INSERT INTO proposed_entities (workspace_id, kind_id, canonical_name, aliases, source_hyobject_id, extracted_by, confidence, state)
   VALUES ($1,2,$2,'{}',$3,'review-check',0.9,'pending') RETURNING id`, [WS, PE_NAME, hyobj])).rows[0].id;
const peRejectId = (await db.query(
  `INSERT INTO proposed_entities (workspace_id, kind_id, canonical_name, aliases, source_hyobject_id, extracted_by, confidence, state)
   VALUES ($1,2,$2,'{}',$3,'review-check',0.5,'pending') RETURNING id`, [WS, PE_REJECT_NAME, hyobj])).rows[0].id;
const spId = (await db.query(
  `INSERT INTO schema_proposals (workspace_id, proposal_type, name, extracted_by, confidence, seen_count, state)
   VALUES ($1,'entity_kind',$2,'review-check',0.9,3,'pending') RETURNING id`, [WS, KIND_NAME])).rows[0].id;
const prId = (await db.query(
  `INSERT INTO proposed_relations (workspace_id, subject_kind, subject_id, object_kind, object_id, predicate, source_hyobject_id, extracted_by, confidence, state)
   VALUES ($1,'entity',$2,'entity',$3,$4,$5,'review-check',0.9,'pending') RETURNING id`, [WS, e1, e2, REL_PRED, hyobj])).rows[0].id;
ok("seeded pending entity, relation, schema type, and a to-reject entity");

const review = (args) =>
  execFileSync(process.execPath, [path.resolve("dist/review.js"), ...args], {
    env: { ...process.env, BRAIN_API_KEY: API_KEY },
  }).toString();

// ── list shows them ──────────────────────────────────────────────────────────
const listed = review([]);
if (listed.includes(PE_NAME) && listed.includes(KIND_NAME) && listed.includes(REL_PRED)) {
  ok("list shows the pending entity, relation, and type");
} else {
  fail("list did not show all seeded proposals");
}

// ── approve entity → canonical entity + mention + state ──────────────────────
review(["approve", peId]);
const ent = (await db.query(`SELECT entity_id FROM entities WHERE workspace_id=$1 AND canonical_name=$2`, [WS, PE_NAME])).rows[0];
const mention = ent ? (await db.query(`SELECT 1 FROM entity_mentions WHERE workspace_id=$1 AND entity_id=$2`, [WS, ent.entity_id])).rowCount : 0;
const peState = (await db.query(`SELECT state, promoted_entity_id FROM proposed_entities WHERE id=$1`, [peId])).rows[0];
if (ent && mention > 0 && peState.state === "approved" && peState.promoted_entity_id === ent.entity_id) {
  ok("approve entity → entity + mention created, proposal marked approved + linked");
} else {
  fail(`approve entity wrong: entity=${!!ent} mention=${mention} state=${peState?.state}`);
}

// ── approve schema type → catalog row + state ────────────────────────────────
review(["approve", spId]);
const kind = (await db.query(`SELECT kind_id FROM entity_kinds WHERE name=$1`, [KIND_NAME])).rows[0];
const spState = (await db.query(`SELECT state, applied_id FROM schema_proposals WHERE id=$1`, [spId])).rows[0];
if (kind && spState.state === "approved" && Number(spState.applied_id) === Number(kind.kind_id)) {
  ok("approve type → entity_kinds catalog row created, proposal approved + applied_id set");
} else {
  fail(`approve type wrong: catalog=${!!kind} state=${spState?.state} applied=${spState?.applied_id}`);
}

// ── approve relation → canonical edge + state ────────────────────────────────
review(["approve", prId]);
const edge = (await db.query(`SELECT 1 FROM entity_relations WHERE workspace_id=$1 AND entity1_id=$2 AND entity2_id=$3 AND predicate=$4`, [WS, e1, e2, REL_PRED])).rowCount;
const prState = (await db.query(`SELECT state FROM proposed_relations WHERE id=$1`, [prId])).rows[0];
if (edge > 0 && prState.state === "approved") {
  ok("approve relation → entity_relations edge created, proposal approved");
} else {
  fail(`approve relation wrong: edge=${edge} state=${prState?.state}`);
}

// ── reject → state flip, nothing promoted ────────────────────────────────────
review(["reject", peRejectId]);
const rejState = (await db.query(`SELECT state FROM proposed_entities WHERE id=$1`, [peRejectId])).rows[0];
const rejPromoted = (await db.query(`SELECT 1 FROM entities WHERE workspace_id=$1 AND canonical_name=$2`, [WS, PE_REJECT_NAME])).rowCount;
if (rejState.state === "rejected" && rejPromoted === 0) {
  ok("reject → proposal rejected and NOT promoted into the graph");
} else {
  fail(`reject wrong: state=${rejState?.state} promoted=${rejPromoted}`);
}

await cleanup();
await db.end();
console.log(`\n=== ${failed === 0 ? "PASS" : "FAIL"} (review) ===`);
process.exit(failed === 0 ? 0 : 1);
