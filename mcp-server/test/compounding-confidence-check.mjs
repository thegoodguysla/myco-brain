#!/usr/bin/env node
/**
 * Compounding-confidence end-to-end check — GATED on a database, no LLM.
 *
 * Exercises the full lifecycle of a fact through the real DB path:
 *   1. corroboration  — a second independent source RAISES the edge's
 *                       confidence (rescoreEntityRelation over relation_evidence)
 *   2. contradiction  — a confident conflicting observation on a FUNCTIONAL
 *                       predicate makes the old edge FALL, closes it
 *                       (valid_to), and supersedes its claim (claims ledger:
 *                       old.superseded_by → new, never overwritten)
 *   3. surfaces       — brain_why shows independent_sources + confidence_trend
 *                       (from the vc audit trail) + the superseded edge;
 *                       brain_stats reports corroborated/superseded counts
 *
 * Synthetic, run-scoped entities; cleans up after itself (rerun-deterministic).
 * Skips (exit 0) when DATABASE_URL is unset — checked BEFORE dist/ imports.
 */
if (!process.env.DATABASE_URL) {
  console.log("[skip] compounding-confidence check — DATABASE_URL is not set.");
  process.exit(0);
}

const [{ canonicalizeAgentContext }, { resolveAuth }, { withSession },
       { rescoreEntityRelation }, { supersedeContradictedRelations },
       { stats, StatsInput }, { why, WhyInput }, { default: pg }] = await Promise.all([
  import("../dist/agent-identity.js"),
  import("../dist/auth.js"),
  import("../dist/db.js"),
  import("../dist/confidence.js"),
  import("../dist/contradiction.js"),
  import("../dist/tools/stats.js"),
  import("../dist/tools/why.js"),
  import("pg"),
]);

const WS = "00000000-0000-0000-0000-000000000001";
const AG = "00000000-0000-0000-0000-0000000000a1";
const { ctx: raw } = resolveAuth({ apiKey: `brain_${WS}_${AG}_localdev`, workspaceId: WS });
const ctx = await canonicalizeAgentContext(raw);

const run = `${Date.now()}`;
let failed = 0;
const ok = (m) => console.log(`ok    ${m}`);
const fail = (m) => {
  failed++;
  console.error(`FAIL  ${m}`);
};
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

// ── Setup: three entities, two source docs, one functional-predicate edge ──
const ids = {};
await withSession(ctx, async (client) => {
  const ent = async (name) =>
    (await client.query(
      `INSERT INTO entities (workspace_id, kind_id, canonical_name, aliases)
       VALUES ($1, 2, $2, $3) RETURNING entity_id`,
      [WS, name, []]
    )).rows[0].entity_id;
  ids.person = await ent(`CcPerson${run}`);
  ids.orgA = await ent(`CcOrgA${run}`);
  ids.orgB = await ent(`CcOrgB${run}`);
  const docs = (await client.query(
    `SELECT hyobject_id FROM hyobjects WHERE workspace_id = $1 LIMIT 2`, [WS]
  )).rows.map((r) => r.hyobject_id);
  ids.docs = docs;

  ids.edge = (await client.query(
    `INSERT INTO entity_relations
       (workspace_id, entity1_id, entity2_id, predicate, source_hyobject_id, confidence)
     VALUES ($1, $2, $3, 'works for', $4, 0.8) RETURNING id`,
    [WS, ids.person, ids.orgA, docs[0]]
  )).rows[0].id;
  await client.query(
    `INSERT INTO relation_evidence
       (workspace_id, relation_kind, relation_row_id, source_node_id, target_node_id,
        predicate, evidence_hyobject_id, confidence, evidence_kind)
     VALUES ($1, 'entity_relation', $2, $3, $4, 'works for', $5, 0.8, 'extraction')`,
    [WS, ids.edge, ids.person, ids.orgA, docs[0]]
  );
});
ok("setup: person works for OrgA (conf 0.8, one source)");

// ── 1. Corroboration RAISES ────────────────────────────────────────────────
await withSession(ctx, async (client) => {
  await client.query(
    `INSERT INTO relation_evidence
       (workspace_id, relation_kind, relation_row_id, source_node_id, target_node_id,
        predicate, evidence_hyobject_id, confidence, evidence_kind)
     VALUES ($1, 'entity_relation', $2, $3, $4, 'works for', $5, 0.7, 'extraction')`,
    [WS, ids.edge, ids.person, ids.orgA, ids.docs[1]]
  );
  const r = await rescoreEntityRelation(client, WS, ids.person, ids.orgA, "works for");
  if (r.sources === 2 && r.confidence > 0.8 && Math.abs(r.confidence - 0.856) < 1e-9) {
    ok(`corroboration raises confidence: 0.8 → ${r.confidence} (2 independent sources)`);
  } else {
    fail(`expected rise to 0.856 with 2 sources, got ${JSON.stringify(r)}`);
  }
});

// ── 2. Contradiction FALLS + supersedes ────────────────────────────────────
let newClaimId = null;
await withSession(ctx, async (client) => {
  // New confident observation: person works for OrgB (functional conflict).
  const res = await supersedeContradictedRelations(
    client, WS, ids.person, "works for", ids.orgB, 0.9, ids.docs[1], "program:cc-check"
  );
  newClaimId = res.new_claim_id;
  if (res.superseded === 1 && newClaimId) {
    ok("contradiction detected and superseded exactly one edge");
  } else {
    fail(`expected 1 superseded + new claim, got ${JSON.stringify(res)}`);
  }
});

const oldEdge = (await db.query(
  `SELECT confidence, valid_to FROM entity_relations WHERE id = $1`, [ids.edge]
)).rows[0];
// fallen = 0.856 * (1 - 0.4*0.9) = 0.54784
if (oldEdge.valid_to !== null && Math.abs(Number(oldEdge.confidence) - 0.54784) < 1e-6) {
  ok(`old edge fell and closed: conf 0.856 → ${Number(oldEdge.confidence)}, valid_to set`);
} else {
  fail(`expected closed edge at ~0.54784, got ${JSON.stringify(oldEdge)}`);
}

const chain = (await db.query(
  `SELECT c_old.value->>'entity_id' AS old_obj, c_old.valid_to IS NOT NULL AS closed,
          c_new.value->>'entity_id' AS new_obj
     FROM claims c_old JOIN claims c_new ON c_new.claim_id = c_old.superseded_by
    WHERE c_old.workspace_id = $1 AND c_old.subject_id = $2 AND c_old.attribute = 'works for'`,
  [WS, ids.person]
)).rows[0];
if (chain && chain.old_obj === ids.orgA && chain.new_obj === ids.orgB && chain.closed) {
  ok("claims ledger: OrgA claim superseded_by → OrgB claim (closed, not overwritten)");
} else {
  fail(`claims chain wrong: ${JSON.stringify(chain)}`);
}

// ── 3. Surfaces ────────────────────────────────────────────────────────────
const whyOut = await why(ctx, WhyInput.parse({ entity_a_id: ids.person, entity_b_id: ids.orgA }));
const sup = whyOut.pairwise_provenance?.superseded_relations ?? [];
if (sup.length === 1 && sup[0].id === ids.edge) {
  ok("brain_why shows the superseded edge (contradiction visible, not hidden)");
} else {
  fail(`brain_why superseded_relations wrong: ${JSON.stringify(sup)}`);
}
// Trend comes from the vc audit trail: insert 0.8 → rescore 0.856 → fall 0.54784.
// The pair (person, OrgA) now has no ACTIVE edge, so check trend via a fresh
// corroborated pair instead: person—OrgB has no evidence yet → build one quickly.
await withSession(ctx, async (client) => {
  const edgeB = (await client.query(
    `INSERT INTO entity_relations
       (workspace_id, entity1_id, entity2_id, predicate, source_hyobject_id, confidence)
     VALUES ($1, $2, $3, 'works for', $4, 0.9) RETURNING id`,
    [WS, ids.person, ids.orgB, ids.docs[1]]
  )).rows[0].id;
  ids.edgeB = edgeB;
  for (const [doc, conf] of [[ids.docs[0], 0.9], [ids.docs[1], 0.8]]) {
    await client.query(
      `INSERT INTO relation_evidence
         (workspace_id, relation_kind, relation_row_id, source_node_id, target_node_id,
          predicate, evidence_hyobject_id, confidence, evidence_kind)
       VALUES ($1, 'entity_relation', $2, $3, $4, 'works for', $5, $6, 'extraction')
       ON CONFLICT DO NOTHING`,
      [WS, edgeB, ids.person, ids.orgB, doc, conf]
    );
  }
  await rescoreEntityRelation(client, WS, ids.person, ids.orgB, "works for");
});
const whyB = await why(ctx, WhyInput.parse({ entity_a_id: ids.person, entity_b_id: ids.orgB }));
const rel = (whyB.pairwise_provenance?.direct_relations ?? [])[0];
if (rel && rel.independent_sources === 2 && rel.confidence_trend && rel.confidence_trend.includes("→")) {
  ok(`brain_why trend: "${rel.confidence_trend}" (${rel.independent_sources} independent sources)`);
} else {
  fail(`brain_why trend missing: ${JSON.stringify(rel)}`);
}

const snapshot = await stats(ctx, StatsInput.parse({}));
if (
  snapshot.evidence?.relations_superseded >= 1 &&
  snapshot.evidence?.relations_corroborated >= 1 &&
  snapshot.evidence?.mean_relation_confidence !== null
) {
  ok(`brain_stats evidence: ${JSON.stringify(snapshot.evidence)}`);
} else {
  fail(`brain_stats evidence section wrong: ${JSON.stringify(snapshot.evidence)}`);
}
if (/evidence: \d+ multi-source facts?, \d+ superseded/.test(snapshot.summary)) {
  ok(`summary surfaces evidence: "...${snapshot.summary.slice(-60)}"`);
} else {
  fail(`summary missing evidence clause: "${snapshot.summary}"`);
}

// ── Cleanup (FK order; vc rows are append-only audit and stay) ─────────────
await db.query(`DELETE FROM relation_evidence WHERE relation_row_id = ANY($1::uuid[])`, [[ids.edge, ids.edgeB]]);
await db.query(`DELETE FROM claims WHERE workspace_id = $1 AND subject_id = $2`, [WS, ids.person]);
await db.query(`DELETE FROM entity_relations WHERE id = ANY($1::uuid[])`, [[ids.edge, ids.edgeB]]);
await db.query(`DELETE FROM entities WHERE entity_id = ANY($1::uuid[])`, [[ids.person, ids.orgA, ids.orgB]]);

await db.end();
console.log(`\n=== ${failed === 0 ? "PASS" : "FAIL"} (compounding-confidence) ===`);
process.exit(failed === 0 ? 0 : 1);
