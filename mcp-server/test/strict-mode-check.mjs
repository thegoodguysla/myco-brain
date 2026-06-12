#!/usr/bin/env node
/**
 * Strict curation mode end-to-end check — GATED on a database.
 *
 * Differential test of BRAIN_REQUIRE_HUMAN_REVIEW=1 using the fake extraction
 * provider (no LLM): "Orgz…" tokens extract as organization @ 0.9, which the
 * worker auto-promotes by default (threshold 0.6).
 *
 *   strict run  → entity waits in proposed_entities (state=pending);
 *                 nothing reaches the canonical entities table
 *   normal run  → entity auto-promotes (state=auto_promoted; entities row)
 *
 * Probe names are unique per run, so reruns are deterministic; created
 * canonical rows are cleaned up at the end.
 *
 * Skips (exit 0) when DATABASE_URL is unset — checked BEFORE the dist/
 * imports so an un-built clone skips cleanly.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

if (!process.env.DATABASE_URL) {
  console.log("[skip] strict-mode check — DATABASE_URL is not set.");
  process.exit(0);
}

const [{ canonicalizeAgentContext }, { resolveAuth },
       { ingest, IngestInput }, { default: pg }] = await Promise.all([
  import("../dist/agent-identity.js"),
  import("../dist/auth.js"),
  import("../dist/tools/ingest.js"),
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
  Number(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM chunk_extraction_status
          WHERE workspace_id = $1 AND status IN ('pending','failed') AND attempts < 3`,
        [WS]
      )
    ).rows[0].n
  );

const drain = async (extraEnv) => {
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
        ...extraEnv,
      },
      stdio: ["ignore", "ignore", "inherit"],
    });
  }
  if ((await pendingCount()) > 0) {
    fail(`extraction queue NOT drained after ${iterations} passes`);
  }
  return iterations;
};

const ing = async (text, key) =>
  ingest(
    ctx,
    IngestInput.parse({
      mode: "text",
      text,
      name: key,
      idempotency_key: key,
      trace_id: `t-${key}`,
      raw_payload: { t: "strict" },
    })
  );

const proposedState = async (name) =>
  (
    await db.query(
      `SELECT state FROM proposed_entities WHERE workspace_id = $1 AND canonical_name = $2`,
      [WS, name]
    )
  ).rows.map((r) => r.state);

const canonicalCount = async (name) =>
  Number(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM entities WHERE workspace_id = $1 AND canonical_name = $2`,
        [WS, name]
      )
    ).rows[0].n
  );

// ── 1. STRICT run: proposal queued, nothing canonical ─────────────────────
const strictName = `OrgzStrict${run}`;
await ing(`${strictName} announced a new initiative today.`, `strict-${run}`);
await drain({ BRAIN_REQUIRE_HUMAN_REVIEW: "1" });

const strictStates = await proposedState(strictName);
if (strictStates.length === 1 && strictStates[0] === "pending") {
  ok(`strict mode: ${strictName} queued for review (state=pending)`);
} else {
  fail(`strict mode: expected one pending proposal, got ${JSON.stringify(strictStates)}`);
}
if ((await canonicalCount(strictName)) === 0) {
  ok("strict mode: canonical entities table untouched");
} else {
  fail(`strict mode: ${strictName} leaked into the canonical entities table`);
}

// ── 2. NORMAL run: same shape of input auto-promotes ───────────────────────
const normalName = `OrgzNormal${run}`;
await ing(`${normalName} announced a new initiative today.`, `normal-${run}`);
await drain({});

const normalStates = await proposedState(normalName);
if (normalStates.length === 1 && normalStates[0] === "auto_promoted") {
  ok(`normal mode: ${normalName} auto-promoted (state=auto_promoted)`);
} else {
  fail(`normal mode: expected one auto_promoted proposal, got ${JSON.stringify(normalStates)}`);
}
if ((await canonicalCount(normalName)) === 1) {
  ok("normal mode: canonical entity created");
} else {
  fail(`normal mode: expected one canonical ${normalName} row`);
}

// ── 3. Seeded relation_types catalog present (migration 048) ──────────────
const seeded = Number(
  (
    await db.query(
      `SELECT count(*)::int AS n FROM relation_types
        WHERE lower(regexp_replace(name, '[_-]+', ' ', 'g'))
              IN ('acquired','founded','works for','reports to','manages','owns','hired','located in')`
    )
  ).rows[0].n
);
if (seeded === 8) {
  ok("relation_types catalog seeded with the 8 canonical predicates");
} else {
  fail(`expected 8 seeded canonical predicates, found ${seeded}`);
}

// ── Cleanup canonical rows created by the normal run ───────────────────────
// (unlink the review-queue row first — promoted_entity_id has an FK on entities)
await db.query(
  `UPDATE proposed_entities SET promoted_entity_id = NULL
    WHERE workspace_id = $1 AND canonical_name = $2`,
  [WS, normalName]
);
await db.query(
  `DELETE FROM entity_mentions WHERE workspace_id = $1
     AND entity_id IN (SELECT entity_id FROM entities WHERE workspace_id = $1 AND canonical_name = $2)`,
  [WS, normalName]
);
await db.query(`DELETE FROM entities WHERE workspace_id = $1 AND canonical_name = $2`, [WS, normalName]);

await db.end();
console.log(`\n=== ${failed === 0 ? "PASS" : "FAIL"} (strict-mode) ===`);
process.exit(failed === 0 ? 0 : 1);
