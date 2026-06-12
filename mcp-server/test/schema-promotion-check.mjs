#!/usr/bin/env node
/**
 * Full dynamic-schema check — GATED on a database, no LLM (fake provider).
 *
 * Proves the complete evolve-the-schema loop:
 *   1. default OFF — corroborated proposals stay pending without the env gate
 *   2. with BRAIN_SCHEMA_AUTO_PROMOTE=1 and two independent documents
 *      proposing the same novel kind ("concept"), the proposal earns
 *      seen_count >= 2 and auto-promotes into entity_kinds
 *      (state='auto_promoted', applied_id set — the audit trail)
 *   3. the promoted kind is USABLE: a third document's "concept" entities now
 *      auto-promote into the canonical entities table (previously impossible
 *      — novel kinds are never promoted)
 *
 * Pre-cleans and post-cleans its rows (rerun-deterministic). Skips (exit 0)
 * when DATABASE_URL is unset — checked BEFORE dist/ imports.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

if (!process.env.DATABASE_URL) {
  console.log("[skip] schema-promotion check — DATABASE_URL is not set.");
  process.exit(0);
}

const [{ canonicalizeAgentContext }, { resolveAuth },
       { ingest, IngestInput }, { stats, StatsInput }, { default: pg }] = await Promise.all([
  import("../dist/agent-identity.js"),
  import("../dist/auth.js"),
  import("../dist/tools/ingest.js"),
  import("../dist/tools/stats.js"),
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
const fail = (m) => {
  failed++;
  console.error(`FAIL  ${m}`);
};
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const workerPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/extraction-worker.js"
);
const pendingCount = async () =>
  Number((await db.query(
    `SELECT count(*)::int AS n FROM chunk_extraction_status
      WHERE workspace_id = $1 AND status IN ('pending','failed') AND attempts < 3`,
    [WS]
  )).rows[0].n);

const drain = async (extraEnv) => {
  let i = 0;
  while ((await pendingCount()) > 0 && i < 20) {
    i++;
    execFileSync(process.execPath, [workerPath, "--once"], {
      env: {
        ...process.env,
        BRAIN_EXTRACTION_FAKE: "1",
        BRAIN_API_KEY: API_KEY,
        BRAIN_WORKSPACE_ID: WS,
        BRAIN_EXTRACTION_BATCH_SIZE: "50",
        BRAIN_SCHEMA_PROPOSAL_MIN_CONFIDENCE: "0.5", // fake emits 0.55
        ...extraEnv,
      },
      stdio: ["ignore", "ignore", "inherit"],
    });
  }
  if ((await pendingCount()) > 0) fail(`queue not drained after ${i} passes`);
};

const ing = async (text, key) =>
  ingest(ctx, IngestInput.parse({
    mode: "text", text, name: key, idempotency_key: key,
    trace_id: `t-${key}`, raw_payload: { t: "promo" },
  }));

const proposal = async () =>
  (await db.query(
    `SELECT state, seen_count, applied_id FROM schema_proposals
      WHERE workspace_id = $1 AND proposal_type = 'entity_kind' AND name = 'concept'`,
    [WS]
  )).rows[0];

// ── 0. Pre-clean leftover state from earlier runs ──────────────────────────
const preClean = async () => {
  await db.query(`DELETE FROM schema_proposals WHERE workspace_id = $1 AND proposal_type = 'entity_kind' AND name = 'concept'`, [WS]);
  // demote canonical entities created under a previously-promoted concept kind
  const kind = await db.query(`SELECT kind_id FROM entity_kinds WHERE lower(name) = 'concept'`);
  if (kind.rows[0]) {
    const kid = kind.rows[0].kind_id;
    await db.query(`UPDATE proposed_entities SET promoted_entity_id = NULL WHERE workspace_id = $1 AND promoted_entity_id IN (SELECT entity_id FROM entities WHERE kind_id = $2)`, [WS, kid]);
    await db.query(`DELETE FROM entity_mentions WHERE workspace_id = $1 AND entity_id IN (SELECT entity_id FROM entities WHERE kind_id = $2)`, [WS, kid]);
    await db.query(`DELETE FROM entities WHERE workspace_id = $1 AND kind_id = $2`, [WS, kid]);
    // review-queue rows recorded under the promoted kind hold an FK to it
    await db.query(`DELETE FROM proposed_entities WHERE workspace_id = $1 AND kind_id = $2`, [WS, kid]);
    await db.query(`DELETE FROM entity_kinds WHERE kind_id = $1`, [kid]);
  }
};
await preClean();
ok("pre-cleaned prior 'concept' state");

// ── 1. Default OFF: two docs corroborate, nothing promotes ────────────────
await ing(`Glimmerfen Vexworth spoke at Quailridge today. (p1 ${run})`, `promo-a-${run}`);
await drain({});
await ing(`Quailridge hosted Glimmerfen again for the annual fair. (p2 ${run})`, `promo-b-${run}`);
await drain({});
let p = await proposal();
if (p && p.state === "pending" && p.seen_count >= 2 && p.applied_id === null) {
  ok(`default OFF: proposal corroborated (seen_count=${p.seen_count}) but still pending`);
} else {
  fail(`expected pending corroborated proposal, got ${JSON.stringify(p)}`);
}

// ── 2. Gate ON: next worker pass promotes into entity_kinds ───────────────
await ing(`Vexworth and Quailridge announced the Glimmerfen pact. (p3 ${run})`, `promo-c-${run}`);
await drain({ BRAIN_SCHEMA_AUTO_PROMOTE: "1", BRAIN_SCHEMA_PROMOTE_MIN_SEEN: "2", BRAIN_SCHEMA_PROMOTE_MIN_CONFIDENCE: "0.5" });
p = await proposal();
const kindRow = (await db.query(`SELECT kind_id FROM entity_kinds WHERE lower(name) = 'concept'`)).rows[0];
if (p?.state === "auto_promoted" && p.applied_id !== null && kindRow && p.applied_id === kindRow.kind_id) {
  ok(`gate ON: 'concept' auto-promoted into entity_kinds (kind_id=${p.applied_id}, audit on proposal row)`);
} else {
  fail(`expected auto_promoted with applied_id, got ${JSON.stringify(p)} / kind=${JSON.stringify(kindRow)}`);
}

// ── 3. The promoted kind is USABLE by the next extraction ─────────────────
// Confidence floor: fake emits 0.55; lower the workspace auto-promote bar so
// the entity promotion path runs (restored in cleanup).
await db.query(`UPDATE workspaces SET settings = coalesce(settings,'{}'::jsonb) || '{"auto_promote_min_confidence":0.5}' WHERE workspace_id = $1`, [WS]);
await ing(`Brindleshaw joined the Glimmerfen pact in spring. (p4 ${run})`, `promo-d-${run}`);
await drain({ BRAIN_SCHEMA_AUTO_PROMOTE: "1", BRAIN_SCHEMA_PROMOTE_MIN_SEEN: "2", BRAIN_SCHEMA_PROMOTE_MIN_CONFIDENCE: "0.5" });
const promotedEntities = Number((await db.query(
  `SELECT count(*)::int AS n FROM entities WHERE workspace_id = $1 AND kind_id = $2`,
  [WS, kindRow?.kind_id ?? -1]
)).rows[0].n);
if (promotedEntities > 0) {
  ok(`promoted kind is live: ${promotedEntities} canonical entit${promotedEntities === 1 ? "y" : "ies"} of kind 'concept' created`);
} else {
  fail("entities of the newly promoted kind were not auto-promoted");
}

// ── 4. brain_stats surfaces the promotion ──────────────────────────────────
const snapshot = await stats(ctx, StatsInput.parse({}));
if (snapshot.schema?.types_auto_promoted >= 1) {
  ok(`brain_stats reports types_auto_promoted=${snapshot.schema.types_auto_promoted}`);
} else {
  fail(`stats missing auto-promotion: ${JSON.stringify(snapshot.schema)}`);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await db.query(`UPDATE workspaces SET settings = settings - 'auto_promote_min_confidence' WHERE workspace_id = $1`, [WS]);
await preClean();

await db.end();
console.log(`\n=== ${failed === 0 ? "PASS" : "FAIL"} (schema-promotion) ===`);
process.exit(failed === 0 ? 0 : 1);
