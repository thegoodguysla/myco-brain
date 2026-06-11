#!/usr/bin/env node
/**
 * Dedup + provenance benchmark.
 *
 * Demonstrates, reproducibly, the two claims at the heart of Myco Brain:
 *   1. DEDUP — re-ingesting identical content does NOT create duplicate memory
 *      (it's rejected by content hash). This is what stops the "same fact saved
 *      ten times in slightly different words" failure mode.
 *   2. PROVENANCE — every stored document carries a content hash and is
 *      source-traceable, so accepted facts can always be traced back.
 *
 * It ingests a small fixture set, ingests it AGAIN (simulating overlapping
 * sources or a re-run of `mycobrain-ingest`), and reports the result. The
 * numbers are deterministic, so anyone can run this and verify the claims.
 *
 * Usage (with the stack running — see the repo README):
 *   export DATABASE_URL=postgresql://brain:brain@localhost:5432/brain
 *   export BRAIN_WORKSPACE_ID=00000000-0000-0000-0000-000000000001
 *   export BRAIN_API_KEY=brain_00000000-0000-0000-0000-000000000001_00000000-0000-0000-0000-0000000000a1_localdev
 *   node examples/benchmark/run.mjs
 */
import { canonicalizeAgentContext } from "../../mcp-server/dist/agent-identity.js";
import { resolveAuth } from "../../mcp-server/dist/auth.js";
import { withSession } from "../../mcp-server/dist/db.js";
import { ingest, IngestInput } from "../../mcp-server/dist/tools/ingest.js";

const WS = process.env.BRAIN_WORKSPACE_ID || "00000000-0000-0000-0000-000000000001";
const AG = "00000000-0000-0000-0000-0000000000a1";
const API_KEY = process.env.BRAIN_API_KEY || `brain_${WS}_${AG}_localdev`;

// Unique per run so repeated benchmark runs don't collide, while identical
// content WITHIN a run still dedupes (that's the point).
const RUN = process.argv[2] || `run-${Date.now()}`;

const fixtures = [
  { name: "offsite", text: `[${RUN}] The Q3 board offsite is in Lisbon on September 9.` },
  { name: "renewal", text: `[${RUN}] Acme's contract renews on October 15 with Jordan.` },
  { name: "checklist", text: `[${RUN}] The launch checklist lives in the ops folder.` },
];
const COPIES = 2; // ingest the whole set twice — overlapping sources

const { ctx: raw } = resolveAuth({ apiKey: API_KEY, workspaceId: WS });
const ctx = await canonicalizeAgentContext(raw);

function envelope(i) {
  return { idempotency_key: `bench-${RUN}-${i}`, trace_id: `bench-${RUN}`, raw_payload: { benchmark: true } };
}

const countDocs = () =>
  withSession(ctx, async (c) =>
    Number((await c.query("SELECT count(*)::int AS n FROM hyobjects WHERE type_id <> 80")).rows[0].n)
  );

const before = await countDocs();

let attempts = 0;
const storedIds = new Set();
for (let copy = 0; copy < COPIES; copy++) {
  for (const f of fixtures) {
    attempts++;
    const r = await ingest(ctx, IngestInput.parse({ mode: "text", text: f.text, name: f.name, ...envelope(attempts) }));
    storedIds.add(r.hyobject_id);
  }
}

const after = await countDocs();

// Provenance: of the documents we just stored, how many carry a content hash
// and are traceable?
const ids = [...storedIds];
const prov = await withSession(ctx, async (c) =>
  c.query(
    `SELECT
       count(*) FILTER (WHERE sha256 IS NOT NULL)::int AS hashed,
       count(*)::int AS total
     FROM hyobjects WHERE hyobject_id = ANY($1::uuid[])`,
    [ids]
  )
);
const stored = after - before;
const blocked = attempts - stored;
const { hashed, total } = prov.rows[0];

console.log("\n  Myco Brain — dedup + provenance benchmark");
console.log("  ------------------------------------------");
console.log(`  Ingest attempts (overlapping sources):   ${attempts}`);
console.log(`  Unique documents actually stored:        ${stored}`);
console.log(`  Duplicate writes blocked by content hash: ${blocked}`);
console.log(`  Distinct hyobjects returned:             ${storedIds.size}`);
console.log(`  Stored docs with a content hash:         ${hashed}/${total} (${total ? Math.round((100 * hashed) / total) : 0}% source-traceable)`);
console.log("  ------------------------------------------");

const dedupOk = stored === fixtures.length && blocked === attempts - fixtures.length;
const provOk = total > 0 && hashed === total;
console.log(dedupOk ? "  ✅ DEDUP: identical content did not create duplicates." : "  ❌ DEDUP: unexpected duplicate count.");
console.log(provOk ? "  ✅ PROVENANCE: every stored document is source-traceable.\n" : "  ❌ PROVENANCE: some documents lack a content hash.\n");

process.exit(dedupOk && provOk ? 0 : 1);
