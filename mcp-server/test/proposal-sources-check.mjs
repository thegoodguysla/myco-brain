#!/usr/bin/env node
/**
 * Schema-proposal distinct-source counting — GATED on a database, no LLM.
 *
 * Proves F4: seen_count counts DISTINCT source DOCUMENTS, so two documents
 * alternating cannot inflate it past the real source count. The old code
 * incremented whenever a sighting differed from the LAST stored source, so a
 * sequence A, B, A reached the promotion gate (>= 3) with only TWO documents.
 *
 * Synthetic, run-scoped rows; cleans up after itself. Skips (exit 0) when
 * DATABASE_URL is unset — checked BEFORE dist/ imports.
 */
if (!process.env.DATABASE_URL) {
  console.log("[skip] proposal-sources check — DATABASE_URL is not set.");
  process.exit(0);
}

const [{ canonicalizeAgentContext }, { resolveAuth }, { withSession },
       { persistSchemaProposals }, { default: pg }] = await Promise.all([
  import("../dist/agent-identity.js"),
  import("../dist/auth.js"),
  import("../dist/db.js"),
  import("../dist/schema-proposals.js"),
  import("pg"),
]);

const WS = "00000000-0000-0000-0000-000000000001";
const AG = "00000000-0000-0000-0000-0000000000a1";
const { ctx: raw } = resolveAuth({ apiKey: `brain_${WS}_${AG}_localdev`, workspaceId: WS });
const ctx = await canonicalizeAgentContext(raw);

const run = `${Date.now()}`;
const NAME = `cdkind${run}`;
let failed = 0;
const ok = (m) => console.log(`ok    ${m}`);
const fail = (m) => { failed++; console.error(`FAIL  ${m}`); };
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

// ── Setup: three distinct source documents ─────────────────────────────────
const docs = [];
await withSession(ctx, async (client) => {
  const typeId = (await client.query(`SELECT type_id FROM hyobject_types ORDER BY type_id LIMIT 1`)).rows[0].type_id;
  const subId = (await client.query(`SELECT subtype_id FROM hyobject_subtypes ORDER BY subtype_id LIMIT 1`)).rows[0].subtype_id;
  for (let i = 0; i < 3; i++) {
    docs.push((await client.query(
      `INSERT INTO hyobjects (workspace_id, type_id, subtype_id, name) VALUES ($1,$2,$3,$4) RETURNING hyobject_id`,
      [WS, typeId, subId, `PsHy${i}${run}`]
    )).rows[0].hyobject_id);
  }
});
const candidate = { proposal_type: "entity_kind", name: NAME, confidence: 0.7 };
const sight = (doc) => withSession(ctx, (c) => persistSchemaProposals(c, WS, doc, "program:test", [candidate]));
const seen = async () => (await db.query(
  `SELECT seen_count FROM schema_proposals WHERE workspace_id=$1 AND proposal_type='entity_kind' AND name=$2`,
  [WS, NAME]
)).rows[0]?.seen_count;

ok(`setup: 3 distinct documents, proposal name '${NAME}'`);

// ── A, then B, then A again → only 2 DISTINCT sources ──────────────────────
await sight(docs[0]);
await sight(docs[1]);
await sight(docs[0]); // repeat — must NOT increment
const after2 = Number(await seen());
if (after2 === 2) ok("F4: A,B,A counts as 2 distinct sources (repeat document does not inflate)");
else fail(`F4: expected seen_count=2 after A,B,A, got ${after2}`);

// ── a genuinely new third document reaches 3 ───────────────────────────────
await sight(docs[2]);
const after3 = Number(await seen());
if (after3 === 3) ok("F4: a third DISTINCT document reaches seen_count=3 (real corroboration still works)");
else fail(`F4: expected seen_count=3 after a 3rd distinct doc, got ${after3}`);

// ── Cleanup (cascade: schema_proposal_sources → schema_proposals) ──────────
await db.query(`DELETE FROM schema_proposals WHERE workspace_id=$1 AND proposal_type='entity_kind' AND name=$2`, [WS, NAME]);
await db.query(`DELETE FROM hyobjects WHERE hyobject_id = ANY($1::uuid[])`, [docs]);

await db.end();
console.log(`\n=== ${failed === 0 ? "PASS" : "FAIL"} (proposal-sources) ===`);
process.exit(failed === 0 ? 0 : 1);
