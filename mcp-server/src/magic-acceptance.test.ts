/**
 * Magic acceptance gate — the integrated end-to-end story in ONE runnable test,
 * so "the magic works" is a repeatable check, not a manual walkthrough:
 *
 *   1. install identity     — each client gets its OWN agent (provisionClientAgent)
 *   2. cross-agent recall    — Cursor saves, Claude recalls a workspace-shared memory
 *   3. provenance surfacing  — the recall says it came from Cursor (source_agent +
 *                              the cross-agent attribution credit)
 *   4. self-check that talks  — working/pending/problems are structured + mode-aware,
 *                              with the per-agent breakdown visible
 *   5. degraded self-heal     — with no embedding provider, the problem is surfaced
 *                              WITH a concrete fix (not a silent failure)
 *   6. provenance stat        — brain_stats carries the per-source-agent breakdown
 *
 * DB-backed; skipped without DATABASE_URL. The unit/DB tests in agent-provenance,
 * client-agent, surfacing-store and check cover each piece in isolation — this is
 * the cohesive acceptance run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool, closePool, type SessionContext } from "./db.js";
import { provisionClientAgent } from "./client-agent.js";
import { ingest, IngestInput } from "./tools/ingest.js";
import { recallMemory } from "./tools/recall-memory.js";
import { selfCheck } from "./tools/check.js";
import { stats } from "./tools/stats.js";

const HAS_DB = !!process.env.DATABASE_URL;
const WS = "00000000-0000-0000-0000-00000000acce";
const BASE_KEY = `brain_${WS}_00000000-0000-0000-0000-0000000000a1_localdev`;
const ctxFor = (agentId: string): SessionContext => ({
  workspaceId: WS,
  principalRole: "agent",
  actorId: agentId,
  actorKind: "agent",
});

describe.skipIf(!HAS_DB)("magic acceptance gate (DB)", () => {
  let cursorAgent = "";
  let claudeAgent = "";

  beforeAll(async () => {
    const c = await getPool().connect();
    try {
      await c.query(
        `INSERT INTO workspaces (workspace_id, name, slug, plan, status, settings)
         VALUES ($1,'Acceptance','acceptance','free','active','{}'::jsonb)
         ON CONFLICT (workspace_id) DO NOTHING`,
        [WS]
      );
      for (const sql of [
        `DELETE FROM chunk_extraction_status WHERE workspace_id = $1`,
        `DELETE FROM chunks WHERE workspace_id = $1`,
        `DELETE FROM memory_write_events WHERE workspace_id = $1`,
        `DELETE FROM hyobjects WHERE workspace_id = $1`,
        `DELETE FROM agents WHERE workspace_id = $1`,
      ]) { try { await c.query(sql, [WS]); } catch { /* tolerate */ } }
      // 1. install identity: each client gets its own agent.
      ({ agentId: cursorAgent } = await provisionClientAgent(c, BASE_KEY, "cursor"));
      ({ agentId: claudeAgent } = await provisionClientAgent(c, BASE_KEY, "claude-code"));
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    const c = await getPool().connect();
    const tol = async (s: string) => { try { await c.query(s, [WS]); } catch { /* tolerate */ } };
    try {
      await tol(`DELETE FROM chunk_extraction_status WHERE workspace_id = $1`);
      await tol(`DELETE FROM chunks WHERE workspace_id = $1`);
      await tol(`DELETE FROM memory_write_events WHERE workspace_id = $1`);
      await tol(`DELETE FROM hyobjects WHERE workspace_id = $1`);
      await tol(`DELETE FROM agents WHERE workspace_id = $1`);
      await tol(`DELETE FROM workspaces WHERE workspace_id = $1`);
    } finally {
      c.release();
    }
    await closePool();
  });

  it("Cursor saves → Claude recalls it AND sees it came from Cursor", async () => {
    await ingest(ctxFor(cursorAgent), IngestInput.parse({
      mode: "text",
      text: "Acceptance fact qwopzilla: the staging gate must pass before prod.",
      name: "acceptance-fact",
      type_id: 1,
    }));
    const res = await recallMemory(ctxFor(claudeAgent), { query: "qwopzilla", limit: 5, include_entities: false, reranker: "none" });
    const hit = res.memories.find((m) => (m.name ?? "").includes("acceptance-fact"));
    expect(hit, "cross-agent recall").toBeTruthy();
    expect(hit!.source_agent?.label).toBe("Cursor");          // provenance surfacing
    expect(res.attribution?.source_agent).toBe("Cursor");      // cross-agent credit
    expect(res.attribution?.surface_hint).toMatch(/from Cursor's memory/);
  });

  it("self-check talks: working + structured problems with fixes + per-agent breakdown", async () => {
    const r = await selfCheck(ctxFor(claudeAgent), { pending_limit: 5 });
    expect(["silent", "ambient", "audit"]).toContain(r.mode);     // mode-aware
    expect(r.working.documents).toBeGreaterThanOrEqual(1);         // moment: it's working
    expect(r.working.by_source.some((e) => e.label === "Cursor")).toBe(true); // provenance stat
    // moment: I found a problem, here's the fix — degraded self-heal (no provider).
    for (const p of r.problems) expect(p.fix).toBeTruthy();
    if (!process.env.BRAIN_EMBED_PROVIDER && !process.env.BRAIN_OPENAI_API_KEY) {
      expect(r.problems.some((p) => p.id === "no_embedding_provider")).toBe(true);
    }
  });

  it("brain_stats carries the per-source-agent breakdown", async () => {
    const s = await stats(ctxFor(claudeAgent), {});
    expect(Array.isArray(s.agents.by_source)).toBe(true);
    expect(s.agents.by_source.some((e) => e.label === "Cursor")).toBe(true);
  });
});
