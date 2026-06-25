import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool, closePool, type SessionContext } from "./db.js";
import {
  sourceAgentLabel,
  resolveSourceAgents,
  agentMemoryBreakdown,
  breakdownSummary,
  attachSourceAgent,
} from "./agent-provenance.js";
import { buildAttribution } from "./attribution.js";
import { ingest, IngestInput } from "./tools/ingest.js";
import { recallMemory } from "./tools/recall-memory.js";
import { contextPack } from "./tools/context-pack.js";
import { selfCheck } from "./tools/check.js";

// ── Pure: label formatting ───────────────────────────────────────────────────
describe("agent-provenance: sourceAgentLabel", () => {
  it("prefers an explicit display_name", () => {
    expect(sourceAgentLabel({ platform: "cursor", display_name: "My Cursor" })).toBe("My Cursor");
  });
  it("maps a known platform when display_name is the generic default", () => {
    expect(sourceAgentLabel({ platform: "claude-code", display_name: "Default Local Agent" })).toBe("Claude Code");
  });
  it("title-cases an unknown platform", () => {
    expect(sourceAgentLabel({ platform: "acme_tool", display_name: null })).toBe("Acme Tool");
  });
  it("returns null for the generic placeholder with no platform", () => {
    expect(sourceAgentLabel({ platform: "other", display_name: "Default Local Agent" })).toBeNull();
    expect(sourceAgentLabel(null)).toBeNull();
  });
});

// ── Pure: breakdown summary + attach ─────────────────────────────────────────
describe("agent-provenance: breakdownSummary", () => {
  it("summarizes when 2+ agents have memories", () => {
    const s = breakdownSummary([
      { agent_id: "a", platform: "claude-code", display_name: "Claude Code", label: "Claude Code", memories: 30 },
      { agent_id: "b", platform: "cursor", display_name: "Cursor", label: "Cursor", memories: 8 },
      { agent_id: "c", platform: "codex", display_name: "Codex", label: "Codex", memories: 4 },
    ]);
    expect(s).toBe("42 memories: 30 Claude Code, 8 Cursor, 4 Codex");
  });
  it("returns null when fewer than 2 agents contributed", () => {
    expect(breakdownSummary([{ agent_id: "a", platform: null, display_name: null, label: "Claude Code", memories: 5 }])).toBeNull();
    expect(breakdownSummary([])).toBeNull();
  });
  it("attachSourceAgent maps agent_id -> source_agent, null when unknown", () => {
    const lookup = new Map([["a", { agent_id: "a", platform: "cursor", display_name: "Cursor", label: "Cursor" }]]);
    const rows = attachSourceAgent([{ agent_id: "a" }, { agent_id: "z" }, { agent_id: null }], lookup);
    expect(rows[0].source_agent?.label).toBe("Cursor");
    expect(rows[1].source_agent).toBeNull();
    expect(rows[2].source_agent).toBeNull();
  });
});

// ── Pure: cross-agent attribution wording ────────────────────────────────────
describe("agent-provenance: cross-agent attribution", () => {
  it("names the source agent when provided", () => {
    const h = buildAttribution({ tier: "full", topMemoryName: "the deploy rule", materiallyUsed: true, sourceAgentLabel: "Cursor" });
    expect(h?.surface_hint).toMatch(/Recalled from Cursor's memory: the deploy rule/);
    expect(h?.source_agent).toBe("Cursor");
  });
  it("falls back to neutral 'your memory' without a label", () => {
    const h = buildAttribution({ tier: "full", topMemoryName: "x", materiallyUsed: true });
    expect(h?.surface_hint).toMatch(/Recalled from your memory: x/);
    expect(h?.source_agent).toBeNull();
  });
});

// ── DB-backed: resolve, breakdown, and end-to-end cross-agent recall ─────────
const HAS_DB = !!process.env.DATABASE_URL;
const TEST_WS = "00000000-0000-0000-0000-00000000a9e7";
const AGENT_CURSOR = "00000000-0000-0000-0000-0000000c0001";
const AGENT_CLAUDE = "00000000-0000-0000-0000-0000000c0002";

const ctxFor = (agentId: string): SessionContext => ({
  workspaceId: TEST_WS,
  principalRole: "agent",
  actorId: agentId,
  actorKind: "agent",
});

describe.skipIf(!HAS_DB)("agent-provenance (DB)", () => {
  // FK-safe purge of all doc state for TEST_WS, so a leftover from a crashed run
  // can't make ingest dedup (and silently skip chunk creation). Tolerant per-stmt.
  const purgeWorkspaceDocs = async (c: import("pg").PoolClient) => {
    for (const sql of [
      `DELETE FROM chunk_extraction_status WHERE workspace_id = $1`,
      `DELETE FROM chunks WHERE workspace_id = $1`,
      `DELETE FROM memory_write_events WHERE workspace_id = $1`,
      `DELETE FROM hyobjects WHERE workspace_id = $1`,
    ]) {
      try { await c.query(sql, [TEST_WS]); } catch { /* tolerate older schema / FK quirks */ }
    }
  };

  beforeAll(async () => {
    const c = await getPool().connect();
    try {
      await c.query(
        `INSERT INTO workspaces (workspace_id, name, slug, plan, status, settings)
         VALUES ($1,'Provenance Test','provenance-test','free','active','{}'::jsonb)
         ON CONFLICT (workspace_id) DO NOTHING`,
        [TEST_WS]
      );
      await purgeWorkspaceDocs(c); // start from a clean slate
      // agents.platform is CHECK-constrained to {paperclip,claude-code,cowork,other};
      // non-Claude clients bucket as 'other' and carry their name in display_name.
      await c.query(
        `INSERT INTO agents (agent_id, workspace_id, platform, display_name)
         VALUES ($1,$2,'other','Cursor'), ($3,$2,'claude-code','Claude Code')
         ON CONFLICT (agent_id) DO UPDATE SET platform = EXCLUDED.platform, display_name = EXCLUDED.display_name`,
        [AGENT_CURSOR, TEST_WS, AGENT_CLAUDE]
      );
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    const c = await getPool().connect();
    const tol = async (sql: string) => { try { await c.query(sql, [TEST_WS]); } catch { /* tolerate */ } };
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

  it("resolveSourceAgents maps ids to labels; unknown ids are absent", async () => {
    const c = await getPool().connect();
    try {
      const m = await resolveSourceAgents(c, TEST_WS, [AGENT_CURSOR, AGENT_CLAUDE, "00000000-0000-0000-0000-0000000c9999", null]);
      expect(m.get(AGENT_CURSOR)?.label).toBe("Cursor");
      expect(m.get(AGENT_CLAUDE)?.label).toBe("Claude Code");
      expect(m.has("00000000-0000-0000-0000-0000000c9999")).toBe(false);
    } finally {
      c.release();
    }
  });

  it("a memory saved by Cursor is recalled by Claude WITH its source agent", async () => {
    // Cursor writes a workspace-shared memory…
    await ingest(ctxFor(AGENT_CURSOR), IngestInput.parse({
      mode: "text",
      text: "The zylophonics deploy rule: always stage before prod.",
      name: "deploy-rule",
      type_id: 1,
    }));

    // …and a DIFFERENT agent (Claude) recalls it.
    const res = await recallMemory(ctxFor(AGENT_CLAUDE), { query: "zylophonics", limit: 5, include_entities: false, reranker: "none" });
    const hit = res.memories.find((m) => (m.name ?? "").includes("deploy-rule"));
    expect(hit, "Claude should recall Cursor's workspace-shared memory").toBeTruthy();
    expect(hit!.source_agent?.label).toBe("Cursor");
    expect(res.attribution?.source_agent).toBe("Cursor");
    expect(res.attribution?.surface_hint).toMatch(/from Cursor's memory/);
  });

  it("context_pack (full-text) carries source_agent + cross-agent credit", async () => {
    const res = await contextPack(ctxFor(AGENT_CLAUDE), {
      query: "zylophonics",
      limit: 5,
      include_entities: false,
      include_people: false,
      include_session_notes: false,
      include_relational_context: false,
      relational_limit: 25,
      reranker: "none",
    });
    const hit = res.chunks.find((c) => (c.hyobject_name ?? "").includes("deploy-rule"));
    expect(hit, "context_pack should return Cursor's workspace-shared chunk").toBeTruthy();
    expect(hit!.source_agent?.label).toBe("Cursor");
    expect(res.attribution?.source_agent).toBe("Cursor");
  });

  it("context_pack hybrid path (with embedding) parses and carries source_agent", async () => {
    // A 1536-dim vector exercises the hybrid query (the embedding table is empty,
    // so RRF falls back to the text hits) — guards the chunks-join in that branch.
    const res = await contextPack(ctxFor(AGENT_CLAUDE), {
      query: "zylophonics",
      embedding: new Array(1536).fill(0),
      limit: 5,
      include_entities: false,
      include_people: false,
      include_session_notes: false,
      include_relational_context: false,
      relational_limit: 25,
      reranker: "none",
    });
    const hit = res.chunks.find((c) => (c.hyobject_name ?? "").includes("deploy-rule"));
    expect(hit, "hybrid context_pack should still return the chunk").toBeTruthy();
    expect(hit!.source_agent?.label).toBe("Cursor");
  });

  it("agentMemoryBreakdown + breakdownSummary reflect per-agent counts", async () => {
    // Add a Claude-authored memory so two agents contribute.
    await ingest(ctxFor(AGENT_CLAUDE), IngestInput.parse({
      mode: "text",
      text: "The zylophonics rollback runbook lives in ops/.",
      name: "rollback-runbook",
      type_id: 1,
    }));
    const c = await getPool().connect();
    try {
      const b = await agentMemoryBreakdown(c, TEST_WS);
      const byLabel = Object.fromEntries(b.map((e) => [e.label, e.memories]));
      expect(byLabel["Cursor"]).toBeGreaterThanOrEqual(1);
      expect(byLabel["Claude Code"]).toBeGreaterThanOrEqual(1);
      expect(breakdownSummary(b)).toMatch(/memories:/);
    } finally {
      c.release();
    }
  });

  it("brain_self_check exposes the per-agent breakdown once 2+ agents contribute", async () => {
    const r = await selfCheck(ctxFor(AGENT_CLAUDE), { pending_limit: 5 });
    const labels = r.working.by_source.map((e) => e.label);
    expect(labels).toContain("Cursor");
    expect(labels).toContain("Claude Code");
    expect(r.working.message).toMatch(/Across agents —/);
  });
});
