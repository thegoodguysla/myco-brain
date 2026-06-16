#!/usr/bin/env node
/**
 * Per-object sharing enforcement check — GATED on a database, no LLM.
 *
 * Visibility matrix for `private` (sharing_type 1) documents:
 *   creator agent  → sees them (search, context_pack, recall, why)
 *   other agent    → does NOT see them (workspace docs still visible)
 *   service role   → sees everything
 *
 * Run-scoped marker strings; cleans up after itself (rerun-deterministic).
 * Skips (exit 0) when DATABASE_URL is unset — checked BEFORE dist/ imports.
 */
if (!process.env.DATABASE_URL) {
  console.log("[skip] sharing check — DATABASE_URL is not set.");
  process.exit(0);
}

const [{ canonicalizeAgentContext }, { resolveAuth },
       { ingest, IngestInput }, { search, SearchInput },
       { why, WhyInput }, { default: pg }] = await Promise.all([
  import("../dist/agent-identity.js"),
  import("../dist/auth.js"),
  import("../dist/tools/ingest.js"),
  import("../dist/tools/search.js"),
  import("../dist/tools/why.js"),
  import("pg"),
]);

const WS = "00000000-0000-0000-0000-000000000001";
const A1 = "00000000-0000-0000-0000-0000000000a1";
const A2 = "00000000-0000-0000-0000-0000000000b2";

const ctxOf = async (agent) => {
  const { ctx } = resolveAuth({
    apiKey: `brain_${WS}_${agent}_localdev`,
    workspaceId: WS,
  });
  return canonicalizeAgentContext(ctx);
};

const run = `${Date.now()}`;
const MARK = `Shareprobe${run}`;
let failed = 0;
const ok = (m) => console.log(`ok    ${m}`);
const fail = (m) => {
  failed++;
  console.error(`FAIL  ${m}`);
};

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

// Second agent (idempotent).
await db.query(
  `INSERT INTO agents (agent_id, workspace_id, platform, display_name)
   VALUES ($1, $2, 'other', 'sharing-check agent B') ON CONFLICT (agent_id) DO NOTHING`,
  [A2, WS]
);

const ctxA = await ctxOf(A1);
const ctxB = await ctxOf(A2);

// ── Agent A creates one PRIVATE and one WORKSPACE doc ──────────────────────
const mk = async (sharing, label) =>
  (
    await ingest(
      ctxA,
      IngestInput.parse({
        mode: "text",
        text: `${MARK} ${label} content about the quarterly mycology report.`,
        name: `${MARK}-${label}`,
        sharing_type_id: sharing,
        idempotency_key: `${MARK}-${label}`,
        trace_id: `t-${MARK}-${label}`,
        raw_payload: { t: "sharing" },
      })
    )
  ).hyobject_id;

const privId = await mk(1, "private");
const wsId = await mk(2, "workspace");
ok(`agent A ingested private=${privId.slice(0, 8)}… workspace=${wsId.slice(0, 8)}…`);

const names = async (ctx) =>
  (await search(ctx, SearchInput.parse({ query: MARK, limit: 10 }))).results.map(
    (r) => r.hyobject_name
  );

// ── Creator sees both docs; other agent only the workspace doc ─────────────
const whyAForPrivate = await why(ctxA, WhyInput.parse({ hyobject_id: privId }));
const whyAForWorkspace = await why(ctxA, WhyInput.parse({ hyobject_id: wsId }));
if (whyAForPrivate.subject?.id === privId && whyAForWorkspace.subject?.id === wsId) {
  ok("creator (agent A) can read both private and workspace docs");
} else {
  fail("creator could not read both private + workspace docs");
}

let whyBWorkspaceVisible = false;
try {
  const whyBForWorkspace = await why(ctxB, WhyInput.parse({ hyobject_id: wsId }));
  whyBWorkspaceVisible = whyBForWorkspace.subject?.id === wsId;
} catch {
  whyBWorkspaceVisible = false;
}
if (whyBWorkspaceVisible) {
  ok("agent B can read the workspace doc");
} else {
  fail("agent B could not read the workspace doc");
}

// ── brain_why on the private doc: creator yes, other agent no ──────────────
const whyA = await why(ctxA, WhyInput.parse({ hyobject_id: privId }));
if (whyA.subject?.id === privId) ok("creator can brain_why the private doc");
else fail("creator could not brain_why own private doc");

let whyBFailed = false;
try {
  await why(ctxB, WhyInput.parse({ hyobject_id: privId }));
} catch {
  whyBFailed = true;
}
if (whyBFailed) ok("agent B cannot brain_why the private doc (not found)");
else fail("agent B could read the private doc via brain_why");

// ── Impersonation: B's key + agent_id/workspace_id overrides must be inert ─
// The override params used to be honored for brain_* keys — that let any
// agent read another agent's private docs. Identity must come from the key.
{
  const { ctx: spoofRaw } = resolveAuth({
    apiKey: `brain_${WS}_${A2}_localdev`,
    workspaceId: "11111111-1111-1111-1111-111111111111",
    agentId: A1,
  });
  if (spoofRaw.actorId === A2 && spoofRaw.workspaceId === WS) {
    ok("agent_id/workspace_id overrides are ignored for brain_* keys");
  } else {
    fail(
      `impersonation hole: key for ${A2} resolved to actor=${spoofRaw.actorId} ws=${spoofRaw.workspaceId}`
    );
  }
  const spoofCtx = await canonicalizeAgentContext(spoofRaw);
  let spoofWhyFailed = false;
  try {
    await why(spoofCtx, WhyInput.parse({ hyobject_id: privId }));
  } catch {
    spoofWhyFailed = true;
  }
  if (spoofWhyFailed) {
    ok("spoofed context still cannot read agent A's private doc");
  } else {
    fail("spoofed context read agent A's private doc via brain_why");
  }
}

// ── Service role sees everything ───────────────────────────────────────────
const svcCtx = {
  workspaceId: WS,
  principalRole: "service",
  actorId: "service:sharing-check",
  actorKind: "program",
};
const seenSvc = await names(svcCtx);
if (seenSvc.some((n) => n?.includes("private"))) {
  ok("service role sees the private doc");
} else {
  fail(`service role should bypass sharing, saw: ${JSON.stringify(seenSvc)}`);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
for (const sql of [
  `DELETE FROM chunk_extraction_status WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE hyobject_id = ANY($1::uuid[]))`,
  `DELETE FROM chunks_openai3small WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE hyobject_id = ANY($1::uuid[]))`,
  `DELETE FROM chunks_ollama_nomic WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE hyobject_id = ANY($1::uuid[]))`,
  `DELETE FROM chunks WHERE hyobject_id = ANY($1::uuid[])`,
]) {
  try { await db.query(sql, [[privId, wsId]]); } catch { /* table may not exist */ }
}
await db.query(`DELETE FROM hyobjects WHERE workspace_id = $1 AND name LIKE $2`, [WS, `${MARK}%`]);

await db.end();
console.log(`\n=== ${failed === 0 ? "PASS" : "FAIL"} (sharing) ===`);
process.exit(failed === 0 ? 0 : 1);
