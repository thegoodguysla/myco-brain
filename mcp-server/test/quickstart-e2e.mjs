#!/usr/bin/env node
/**
 * Quickstart end-to-end check.
 *
 * Proves that a fresh boot (migrations + seed applied, server built) can run
 * every tool the README/quickstart demos rely on. This is the guard that the
 * "fresh clone → first memory in under 10 minutes" promise stays true: if a
 * migration, the seed, or a tool regresses, this fails in CI instead of in a
 * new user's terminal.
 *
 * Assumes:
 *   - DATABASE_URL points at a Postgres with all migrations + the seed applied
 *   - the server has been built (dist/ exists)
 *
 * Exits non-zero on any failure.
 */
import { canonicalizeAgentContext } from "../dist/agent-identity.js";
import { resolveAuth } from "../dist/auth.js";
import { saveMemory, SaveMemoryInput } from "../dist/tools/save-memory.js";
import { recallMemory, RecallMemoryInput } from "../dist/tools/recall-memory.js";
import { search, SearchInput } from "../dist/tools/search.js";
import { contextPack, ContextPackInput } from "../dist/tools/context-pack.js";
import { why, WhyInput } from "../dist/tools/why.js";
import { ingest, IngestInput } from "../dist/tools/ingest.js";
import { proposeFact, ProposeFactInput } from "../dist/tools/propose-fact.js";
import { neighbors, NeighborsInput } from "../dist/tools/neighbors.js";
import { getRelated, GetRelatedInput } from "../dist/tools/get-related.js";
import { stats, StatsInput } from "../dist/tools/stats.js";

// The default local workspace/agent seeded by
// supabase/migrations/20260601000045_seed_default_local_workspace.sql
const WS = "00000000-0000-0000-0000-000000000001";
const AG = "00000000-0000-0000-0000-0000000000a1";

const { ctx: raw } = resolveAuth({
  apiKey: `brain_${WS}_${AG}_localdev`,
  workspaceId: WS,
});
const ctx = await canonicalizeAgentContext(raw);

// Unique suffix per run so idempotency keys don't collide across reruns
// against a persistent DB. (No Math.random/Date in workflow scripts, but this
// is a plain node script, so a timestamp is fine here.)
const run = `${Date.now()}`;
const env = (k) => ({
  idempotency_key: `${k}-${run}`,
  trace_id: `t-${k}-${run}`,
  raw_payload: { test: k },
});

let passed = 0;
let failed = 0;
const fail = (label, err) => {
  failed++;
  console.error(`FAIL  ${label}: ${String(err && err.message ? err.message : err).split("\n")[0]}`);
};
const pass = (label) => {
  passed++;
  console.log(`ok    ${label}`);
};

// Each step parses input through the tool's Zod schema exactly like the MCP
// dispatcher does, then invokes the tool. Calling the tool fn directly would
// skip schema defaults and give misleading results.
async function step(label, Schema, fn, rawArgs) {
  try {
    const input = Schema.parse(rawArgs);
    const result = await fn(ctx, input);
    pass(label);
    return result;
  } catch (err) {
    fail(label, err);
    return null;
  }
}

await step("save_memory (Demo 1: cross-session recall)", SaveMemoryInput, saveMemory, {
  content: "The board meeting is every Wednesday at 9 AM Pacific.",
  summary: "board meeting time",
  ...env("board"),
});
// THE out-of-the-box shape: a bare {content} call, exactly what every MCP
// agent sends when the model follows the advertised tool schema. Regression
// guard for the launch-week bug where mandatory contract fields made this
// shape fail for all real clients (fields now auto-generate server-side).
await step("save_memory (minimal args — the real MCP client shape)", SaveMemoryInput, saveMemory, {
  content: "Out-of-the-box memory save works with no contract fields supplied.",
});
await step("recall_memory (Demo 2: cross-agent shared memory)", RecallMemoryInput, recallMemory, {
  query: "board meeting",
  limit: 5,
});
await step("search (BM25, no API key)", SearchInput, search, { query: "board meeting", limit: 5 });
await step("context_pack", ContextPackInput, contextPack, { query: "when is the board meeting" });

const ing = await step("ingest (Demo 4: document ingestion)", IngestInput, ingest, {
  mode: "text",
  text: "The launch checklist lives in the ops folder.",
  name: "ops note",
  ...env("ops"),
});

// Dedup guard: re-ingesting identical content must return the SAME hyobject,
// not a duplicate. This is the core "no duplicate memory" promise — without it,
// re-running `mycobrain-ingest` on a folder would multiply every document.
if (ing && ing.hyobject_id) {
  try {
    const again = await ingest(
      ctx,
      IngestInput.parse({
        mode: "text",
        text: "The launch checklist lives in the ops folder.",
        name: "ops note (re-ingest)",
        ...env("ops-dup"),
      })
    );
    if (again.hyobject_id === ing.hyobject_id) {
      pass("ingest dedup: identical content returns same hyobject");
    } else {
      fail(
        "ingest dedup",
        `re-ingest created a duplicate (${again.hyobject_id} != ${ing.hyobject_id})`
      );
    }
  } catch (err) {
    fail("ingest dedup", err);
  }
}

if (ing && ing.hyobject_id) {
  await step("why (Demo 3: provenance)", WhyInput, why, { hyobject_id: ing.hyobject_id });
  await step("propose_fact (entity)", ProposeFactInput, proposeFact, {
    kind: "entity",
    entity_kind_id: 1,
    canonical_name: "Acme Corp",
    source_hyobject_id: ing.hyobject_id,
    ...env("acme"),
  });
  await step("neighbors (Demo 5: graph)", NeighborsInput, neighbors, {
    node_id: ing.hyobject_id,
    node_kind: "hyobject",
  });
  await step("get_related", GetRelatedInput, getRelated, {
    subject_id: ing.hyobject_id,
    subject_kind: "hyobject",
  });
} else {
  fail("why/propose_fact/neighbors/get_related", "ingest did not return a hyobject_id");
}

// Regression guard: multi-word full-text retrieval MUST return hits.
// A prior bug used AND-semantics plainto_tsquery, so any multi-word question
// returned zero (search, context_pack, recall_memory all hit it). Asserting
// >0 here locks in OR semantics — a "ran without throwing" check would not.
async function assertHits(label, Schema, fn, rawArgs, pick) {
  try {
    const r = await fn(ctx, Schema.parse(rawArgs));
    const n = pick(r) ?? 0;
    if (n > 0) pass(`${label} → ${n} hits`);
    else fail(label, `expected >0 hits for a multi-word query, got ${n}`);
  } catch (err) {
    fail(label, err);
  }
}
await assertHits(
  "search returns hits for a multi-word query",
  SearchInput,
  search,
  { query: "where does the launch checklist live", limit: 5 },
  (r) => r.results?.length
);
await assertHits(
  "context_pack returns hits for a multi-word query",
  ContextPackInput,
  contextPack,
  { query: "where does the launch checklist live" },
  (r) => r.chunks?.length
);

const snapshot = await step("stats (memory health)", StatsInput, stats, {});
if (snapshot && snapshot.summary) {
  console.log(`\nstats: ${snapshot.summary}`);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
