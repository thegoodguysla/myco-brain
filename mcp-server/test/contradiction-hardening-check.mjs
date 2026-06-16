#!/usr/bin/env node
/**
 * Contradiction / supersession hardening check — GATED on a database, no LLM.
 *
 * Proves the PR C fixes in contradiction.ts:
 *   F6 — two CONCURRENT contradictions of the same functional triple leave
 *        exactly ONE active object (advisory-lock serialization).
 *   F7 — an incoming "reports_to" supersedes a stored "reports to" edge
 *        (predicate matched in normalized form, not raw).
 *   F8 — re-firing the same contradiction does NOT duplicate the new-fact claim.
 *
 * Synthetic, run-scoped rows; cleans up after itself (rerun-deterministic).
 * Skips (exit 0) when DATABASE_URL is unset — checked BEFORE dist/ imports.
 */
if (!process.env.DATABASE_URL) {
  console.log("[skip] contradiction-hardening check — DATABASE_URL is not set.");
  process.exit(0);
}

const [{ canonicalizeAgentContext }, { resolveAuth }, { withSession },
       { supersedeContradictedRelations }, { default: pg }] = await Promise.all([
  import("../dist/agent-identity.js"),
  import("../dist/auth.js"),
  import("../dist/db.js"),
  import("../dist/contradiction.js"),
  import("pg"),
]);

const WS = "00000000-0000-0000-0000-000000000001";
const AG = "00000000-0000-0000-0000-0000000000a1";
const { ctx: raw } = resolveAuth({ apiKey: `brain_${WS}_${AG}_localdev`, workspaceId: WS });
const ctx = await canonicalizeAgentContext(raw);

const run = `${Date.now()}`;
let failed = 0;
const ok = (m) => console.log(`ok    ${m}`);
const fail = (m) => { failed++; console.error(`FAIL  ${m}`); };
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

// ── Setup: a doc + 9 entities ──────────────────────────────────────────────
const ids = { ent: [] };
await withSession(ctx, async (client) => {
  const typeId = (await client.query(`SELECT type_id FROM hyobject_types ORDER BY type_id LIMIT 1`)).rows[0].type_id;
  const subId = (await client.query(`SELECT subtype_id FROM hyobject_subtypes ORDER BY subtype_id LIMIT 1`)).rows[0].subtype_id;
  ids.doc = (await client.query(
    `INSERT INTO hyobjects (workspace_id, type_id, subtype_id, name) VALUES ($1,$2,$3,$4) RETURNING hyobject_id`,
    [WS, typeId, subId, `CdHy${run}`]
  )).rows[0].hyobject_id;
  const ent = async (name) => {
    const id = (await client.query(
      `INSERT INTO entities (workspace_id, kind_id, canonical_name, aliases) VALUES ($1,2,$2,$3) RETURNING entity_id`,
      [WS, `${name}${run}`, []]
    )).rows[0].entity_id;
    ids.ent.push(id);
    return id;
  };
  ids.p6 = await ent("CdP6"); ids.o6a = await ent("CdO6a"); ids.o6b = await ent("CdO6b");
  ids.p7 = await ent("CdP7"); ids.o7a = await ent("CdO7a"); ids.o7b = await ent("CdO7b");
  ids.p8 = await ent("CdP8"); ids.o8a = await ent("CdO8a"); ids.o8b = await ent("CdO8b");
});
ok("setup: doc + 9 entities");

const mkEdge = (client, s, o, predicate, conf) =>
  client.query(
    `INSERT INTO entity_relations (workspace_id, entity1_id, entity2_id, predicate, source_hyobject_id, confidence)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [WS, s, o, predicate, ids.doc, conf]
  );
const activeCount = async (s, predLower) =>
  Number((await db.query(
    `SELECT count(*)::int n FROM entity_relations
      WHERE workspace_id=$1 AND entity1_id=$2 AND lower(predicate)=$3 AND valid_to IS NULL`,
    [WS, s, predLower]
  )).rows[0].n);

// ── F6: two CONCURRENT contradictions of the same functional triple ────────
// Without serialization both transactions can miss the other's not-yet-committed
// edge and leave two active objects; the advisory lock forces the later one to
// see + supersede the first.
await Promise.all([
  withSession(ctx, async (c) => {
    await mkEdge(c, ids.p6, ids.o6a, "works for", 0.9);
    await supersedeContradictedRelations(c, WS, ids.p6, "works for", ids.o6a, 0.9, ids.doc, "race-a");
  }),
  withSession(ctx, async (c) => {
    await mkEdge(c, ids.p6, ids.o6b, "works for", 0.9);
    await supersedeContradictedRelations(c, WS, ids.p6, "works for", ids.o6b, 0.9, ids.doc, "race-b");
  }),
]);
const a6 = await activeCount(ids.p6, "works for");
if (a6 === 1) ok("F6: two concurrent contradictions leave exactly ONE active functional object");
else fail(`F6: expected 1 active functional edge, got ${a6}`);

// ── F7: "reports_to" supersedes a stored "reports to" (separator-insensitive) ─
await withSession(ctx, async (c) => { await mkEdge(c, ids.p7, ids.o7a, "reports to", 0.8); });
const r7 = await withSession(ctx, (c) =>
  supersedeContradictedRelations(c, WS, ids.p7, "reports_to", ids.o7b, 0.9, ids.doc, "f7"));
const o7a = (await db.query(
  `SELECT valid_to FROM entity_relations WHERE workspace_id=$1 AND entity1_id=$2 AND entity2_id=$3`,
  [WS, ids.p7, ids.o7a]
)).rows[0];
if (r7.superseded === 1 && o7a?.valid_to !== null) {
  ok(`F7: incoming "reports_to" superseded the stored "reports to" edge`);
} else {
  fail(`F7: expected 1 superseded + closed edge, got superseded=${r7.superseded}, valid_to=${o7a?.valid_to}`);
}

// ── F8: re-firing the same contradiction does not duplicate the new claim ──
await withSession(ctx, async (c) => { await mkEdge(c, ids.p8, ids.o8a, "works for", 0.8); });
await withSession(ctx, (c) => supersedeContradictedRelations(c, WS, ids.p8, "works for", ids.o8b, 0.9, ids.doc, "f8-1"));
// re-open o8a, then fire the SAME (p8, works for, o8b) contradiction again
await withSession(ctx, async (c) => { await mkEdge(c, ids.p8, ids.o8a, "works for", 0.8); });
await withSession(ctx, (c) => supersedeContradictedRelations(c, WS, ids.p8, "works for", ids.o8b, 0.9, ids.doc, "f8-2"));
const o8bClaims = Number((await db.query(
  `SELECT count(*)::int n FROM claims
    WHERE workspace_id=$1 AND subject_id=$2 AND attribute='works for'
      AND value->>'entity_id'=$3 AND superseded_by IS NULL`,
  [WS, ids.p8, ids.o8b]
)).rows[0].n);
if (o8bClaims === 1) ok("F8: re-fired contradiction reuses the active new-fact claim (no duplicate)");
else fail(`F8: expected exactly 1 active new-fact claim, got ${o8bClaims}`);

// ── Cleanup ────────────────────────────────────────────────────────────────
await db.query(`DELETE FROM claims WHERE workspace_id=$1 AND subject_id = ANY($2::uuid[])`, [WS, ids.ent]);
await db.query(`DELETE FROM entity_relations WHERE workspace_id=$1 AND entity1_id = ANY($2::uuid[])`, [WS, ids.ent]);
await db.query(`DELETE FROM entities WHERE entity_id = ANY($1::uuid[])`, [ids.ent]);
await db.query(`DELETE FROM hyobjects WHERE hyobject_id=$1`, [ids.doc]);

await db.end();
console.log(`\n=== ${failed === 0 ? "PASS" : "FAIL"} (contradiction-hardening) ===`);
process.exit(failed === 0 ? 0 : 1);
