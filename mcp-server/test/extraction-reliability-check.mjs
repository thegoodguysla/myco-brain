#!/usr/bin/env node
/**
 * Extraction-worker reliability check — GATED on a database, no LLM.
 *
 * Proves the PR A durability fixes against the real DB path:
 *   F1 reaper      — a chunk stranded in 'processing' by a crashed/restarted
 *                    worker is reclaimed once its lease expires: re-queued to
 *                    'pending' while attempts remain, terminally 'failed' when
 *                    exhausted — and a still-fresh 'processing' chunk is left
 *                    alone (never stolen mid-flight).
 *   F2 markFailed  — terminal status is decided by ATTEMPTS, not a substring of
 *                    the error text: exhausted → 'failed', otherwise 'pending'.
 *
 * Synthetic, run-scoped rows; cleans up after itself (rerun-deterministic).
 * Skips (exit 0) when DATABASE_URL is unset — checked BEFORE dist/ imports.
 */
if (!process.env.DATABASE_URL) {
  console.log("[skip] extraction-reliability check — DATABASE_URL is not set.");
  process.exit(0);
}

const [{ canonicalizeAgentContext }, { resolveAuth }, { withSession },
       { reapStaleProcessing, claimChunkBatch, markChunkFailed }] =
  await Promise.all([
    import("../dist/agent-identity.js"),
    import("../dist/auth.js"),
    import("../dist/db.js"),
    import("../dist/extraction-lifecycle.js"),
  ]);

const WS = "00000000-0000-0000-0000-000000000001";
const AG = "00000000-0000-0000-0000-0000000000a1";
const { ctx: raw } = resolveAuth({ apiKey: `brain_${WS}_${AG}_localdev`, workspaceId: WS });
const ctx = await canonicalizeAgentContext(raw);

const run = `${Date.now()}`;
let failed = 0;
const ok = (m) => console.log(`ok    ${m}`);
const fail = (m) => { failed++; console.error(`FAIL  ${m}`); };

// ── Setup: one hyobject + four chunks, each with a chunk_extraction_status row
//    in a chosen state. updated_at is set at INSERT time (the set_updated_at
//    trigger is BEFORE UPDATE only, so insert-time values survive). ──
const ids = {};
await withSession(ctx, async (client) => {
  const typeId = (await client.query(`SELECT type_id FROM hyobject_types ORDER BY type_id LIMIT 1`)).rows[0].type_id;
  const subId = (await client.query(`SELECT subtype_id FROM hyobject_subtypes ORDER BY subtype_id LIMIT 1`)).rows[0].subtype_id;
  ids.hy = (await client.query(
    `INSERT INTO hyobjects (workspace_id, type_id, subtype_id, name) VALUES ($1,$2,$3,$4) RETURNING hyobject_id`,
    [WS, typeId, subId, `RelHy${run}`]
  )).rows[0].hyobject_id;

  const mkChunk = async (idx, status, attempts, ageMs) => {
    const chunkId = (await client.query(
      `INSERT INTO chunks (hyobject_id, workspace_id, chunk_index, text) VALUES ($1,$2,$3,$4) RETURNING chunk_id`,
      [ids.hy, WS, idx, `rel-chunk-${idx}-${run}`]
    )).rows[0].chunk_id;
    await client.query(
      `INSERT INTO chunk_extraction_status (chunk_id, workspace_id, status, attempts, updated_at)
       VALUES ($1, $2, $3, $4, now() - ($5 * interval '1 millisecond'))`,
      [chunkId, WS, status, attempts, ageMs]
    );
    return chunkId;
  };
  ids.staleRetry = await mkChunk(0, "processing", 1, 3_600_000); // 1h-stale, attempts left
  ids.staleDead  = await mkChunk(1, "processing", 3, 3_600_000); // 1h-stale, exhausted
  ids.fresh      = await mkChunk(2, "processing", 1, 0);          // fresh, in-flight
  ids.exhausted  = await mkChunk(3, "pending", 3, 0);             // pending past the cap
});
ok("setup: 4 chunks (stale-retry, stale-dead, fresh-processing, exhausted-pending)");

const statusOf = (chunkId) =>
  withSession(ctx, async (client) =>
    (await client.query(`SELECT status, attempts FROM chunk_extraction_status WHERE chunk_id = $1`, [chunkId])).rows[0]);

// ── F1: reaper (lease 5 min, MAX_ATTEMPTS 3) ──
await withSession(ctx, (client) => reapStaleProcessing(client, WS, { maxAttempts: 3, leaseMs: 300_000 }));

let s = await statusOf(ids.staleRetry);
if (s.status === "pending" && Number(s.attempts) === 1) ok("F1: stale 'processing' (attempts left) re-queued to 'pending'");
else fail(`F1 reaper re-queue: expected pending/1, got ${JSON.stringify(s)}`);

s = await statusOf(ids.staleDead);
if (s.status === "failed") ok("F1: stale 'processing' past the attempt cap terminally 'failed' (not stuck)");
else fail(`F1 reaper terminal: expected failed, got ${JSON.stringify(s)}`);

s = await statusOf(ids.fresh);
if (s.status === "processing") ok("F1: fresh 'processing' (within lease) left alone — not stolen mid-flight");
else fail(`F1 reaper fresh: expected processing, got ${JSON.stringify(s)}`);

// ── claim respects the attempt cap + the reaper fed it real work ──
const claimed = await withSession(ctx, (client) =>
  claimChunkBatch(client, WS, { batchSize: 10, maxAttempts: 3, leaseMs: 300_000 }));
const claimedIds = new Set(claimed.map((c) => c.chunkId));
if (claimedIds.has(ids.staleRetry)) ok("claim: the re-queued chunk is claimable again (attempts incremented on lease)");
else fail(`claim: expected re-queued chunk to be claimed, got ${[...claimedIds]}`);
if (!claimedIds.has(ids.exhausted) && !claimedIds.has(ids.staleDead)) ok("claim: exhausted/terminal chunks are NOT re-claimed");
else fail("claim: must not claim exhausted/dead chunks");

// ── F2: markChunkFailed terminal-by-attempts (not by error text) ──
const f2dead = await withSession(ctx, (client) => markChunkFailed(client, ids.staleDead, "boom: no 'a' word here", { maxAttempts: 3 }));
if (f2dead === "failed") ok("F2: markChunkFailed at the attempt cap → 'failed' (terminal)");
else fail(`F2 terminal: expected failed, got ${f2dead}`);

const f2retry = await withSession(ctx, (client) => markChunkFailed(client, ids.fresh, "transient blip", { maxAttempts: 3 }));
if (f2retry === "pending") ok("F2: markChunkFailed below the cap → 'pending' (retryable)");
else fail(`F2 retryable: expected pending, got ${f2retry}`);

// ── Cleanup (cascade: chunk_extraction_status → chunks → hyobjects) ──
await withSession(ctx, async (client) => {
  await client.query(`DELETE FROM chunks WHERE hyobject_id = $1`, [ids.hy]);
  await client.query(`DELETE FROM hyobjects WHERE hyobject_id = $1`, [ids.hy]);
});

console.log(`\n=== ${failed === 0 ? "PASS" : "FAIL"} (extraction-reliability) ===`);
process.exit(failed === 0 ? 0 : 1);
