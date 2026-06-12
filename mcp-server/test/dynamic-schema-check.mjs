#!/usr/bin/env node
/**
 * Dynamic schema (phase 1) end-to-end check — GATED on a database.
 *
 * Proves the propose-and-surface loop with no LLM at all (uses the fake
 * extraction provider, so it runs anywhere a migrated Postgres runs):
 *   1. ingest novel content → extraction queue rows
 *   2. run the extraction worker until the queue drains (BRAIN_EXTRACTION_FAKE=1;
 *      the fake extractor labels entities kind "concept", which is NOT in the
 *      entity_kinds catalog) → schema_proposals rows appear (state=pending)
 *   3. brain_stats surfaces "Brain proposed N new types from your data"
 *   4. persistSchemaProposals dedupes via the UNIQUE constraint
 *
 * Rerun-deterministic: the run-scoped relation-type row is deleted at the end,
 * and the 'concept' entity-kind row is deleted at the START so each run proves
 * the worker actually re-creates it (no vacuous pass from leftover state).
 *
 * Requires DATABASE_URL (all migrations + seed applied) and a built dist/.
 * Skips (exit 0) when DATABASE_URL is unset — checked BEFORE the dist/ imports
 * so a fresh un-built clone skips cleanly instead of crashing.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

if (!process.env.DATABASE_URL) {
  console.log("[skip] dynamic-schema check — DATABASE_URL is not set.");
  process.exit(0);
}

// dist/ modules are loaded only after the gate, so the documented skip works
// even when the server hasn't been built yet.
const [{ canonicalizeAgentContext }, { resolveAuth }, { withSession },
       { ingest, IngestInput }, { stats, StatsInput },
       { persistSchemaProposals }, { default: pg }] = await Promise.all([
  import("../dist/agent-identity.js"),
  import("../dist/auth.js"),
  import("../dist/db.js"),
  import("../dist/tools/ingest.js"),
  import("../dist/tools/stats.js"),
  import("../dist/schema-proposals.js"),
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

// ── 0. Clean leftover state so this run proves the worker writes fresh ─────
await db.query(
  `DELETE FROM schema_proposals
    WHERE workspace_id = $1 AND proposal_type = 'entity_kind' AND name = 'concept'`,
  [WS]
);

// ── 1. Ingest novel content (enqueues extraction) ─────────────────────────
await ingest(
  ctx,
  IngestInput.parse({
    mode: "text",
    text:
      `Glowforge launched the Aura craft cutter at MakerFest. ` +
      `Glowforge sponsors the local maker guild. (ref ${run})`,
    name: `schema-check-${run}`,
    idempotency_key: `schema-${run}`,
    trace_id: `t-schema-${run}`,
    raw_payload: { t: "schema" },
  })
);
ok("ingested novel content");

// ── 2. Drain the extraction queue with the fake provider ──────────────────
const workerPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/extraction-worker.js"
);
const pendingCount = async () =>
  Number(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM chunk_extraction_status
          WHERE workspace_id = $1 AND status IN ('pending','failed') AND attempts < 3`,
        [WS]
      )
    ).rows[0].n
  );

let iterations = 0;
while ((await pendingCount()) > 0 && iterations < 20) {
  iterations++;
  execFileSync(process.execPath, [workerPath, "--once"], {
    env: {
      ...process.env,
      BRAIN_EXTRACTION_FAKE: "1",
      BRAIN_API_KEY: API_KEY,
      BRAIN_WORKSPACE_ID: WS,
      BRAIN_EXTRACTION_BATCH_SIZE: "50",
      // The fake extractor emits confidence 0.55; lower the proposal floor so
      // this check exercises the write path deterministically.
      BRAIN_SCHEMA_PROPOSAL_MIN_CONFIDENCE: "0.5",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
}
const remaining = await pendingCount();
if (remaining === 0) {
  ok(`extraction queue drained in ${iterations} worker pass(es)`);
} else {
  fail(`extraction queue NOT drained after ${iterations} passes (${remaining} still pending)`);
}

// ── 3. Novel entity kind proposed (fresh, by THIS run)? ────────────────────
// The fake extractor labels everything kind "concept" — not in the catalog —
// and step 0 deleted any leftover row, so this asserts the worker's write.
const proposal = await db.query(
  `SELECT name, state, extracted_by FROM schema_proposals
    WHERE workspace_id = $1 AND proposal_type = 'entity_kind' AND name = 'concept'`,
  [WS]
);
if (proposal.rows.length === 1 && proposal.rows[0].state === "pending") {
  ok(`entity_kind 'concept' proposed (state=pending, by ${proposal.rows[0].extracted_by})`);
} else {
  fail(`expected one pending entity_kind 'concept' proposal, got ${JSON.stringify(proposal.rows)}`);
}

// ── 4. brain_stats surfaces it ─────────────────────────────────────────────
const snapshot = await stats(ctx, StatsInput.parse({}));
if (snapshot.schema?.proposed_types_pending > 0 && snapshot.schema?.entity_kinds_pending > 0) {
  ok(`brain_stats reports ${snapshot.schema.proposed_types_pending} pending proposed type(s)`);
} else {
  fail(`brain_stats schema section did not report proposals: ${JSON.stringify(snapshot.schema)}`);
}
if (/Brain proposed \d+ new types? from your data/.test(snapshot.summary)) {
  ok(`summary surfaces proposals: "...${snapshot.summary.slice(-70)}"`);
} else {
  fail(`summary does not surface proposals: "${snapshot.summary}"`);
}

// ── 5. Dedupe via the UNIQUE constraint ────────────────────────────────────
const uniqueName = `sponsors r${run.slice(-8)}`;
const candidate = [{ proposal_type: "relation_type", name: uniqueName, confidence: 0.8 }];
const first = await withSession(ctx, (client) =>
  persistSchemaProposals(client, WS, null, "program:dynamic-schema-check", candidate)
);
const second = await withSession(ctx, (client) =>
  persistSchemaProposals(client, WS, null, "program:dynamic-schema-check", candidate)
);
if (first === 1 && second === 0) {
  ok("repeat sightings dedupe (1 created, then 0 on conflict)");
} else {
  fail(`expected 1 then 0 inserts, got ${first} then ${second}`);
}
// Clean up the synthetic relation-type row so reruns stay deterministic.
await db.query(
  `DELETE FROM schema_proposals WHERE workspace_id = $1 AND proposal_type = 'relation_type' AND name = $2`,
  [WS, uniqueName]
);

await db.end();
console.log(`\n=== ${failed === 0 ? "PASS" : "FAIL"} (dynamic-schema) ===`);
process.exit(failed === 0 ? 0 : 1);
