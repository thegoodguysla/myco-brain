import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool, closePool, type SessionContext } from "./db.js";
import {
  clientIdentity,
  clientAgentId,
  clientApiKey,
  supportsPerClientAgent,
  provisionClientAgent,
} from "./client-agent.js";
import { ingest, IngestInput } from "./tools/ingest.js";

// ── Pure: identity + deterministic id + key ──────────────────────────────────
describe("client-agent: identity mapping", () => {
  it("Claude Code keeps its own platform; others bucket as 'other' with a name", () => {
    expect(clientIdentity("claude-code")).toEqual({ platform: "claude-code", display_name: "Claude Code" });
    expect(clientIdentity("cursor")).toEqual({ platform: "other", display_name: "Cursor" });
    expect(clientIdentity("codex")).toEqual({ platform: "other", display_name: "Codex" });
  });
  it("unknown clients fall back to 'other' + the raw key", () => {
    expect(clientIdentity("acme")).toEqual({ platform: "other", display_name: "acme" });
  });
});

describe("client-agent: deterministic agent id", () => {
  const WS = "00000000-0000-0000-0000-0000000000aa";
  it("is stable for the same (workspace, client) and a valid v5 uuid", () => {
    const a = clientAgentId(WS, "cursor");
    const b = clientAgentId(WS, "cursor");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("differs by client and by workspace", () => {
    expect(clientAgentId(WS, "cursor")).not.toBe(clientAgentId(WS, "codex"));
    expect(clientAgentId(WS, "cursor")).not.toBe(clientAgentId("00000000-0000-0000-0000-0000000000ab", "cursor"));
  });
});

describe("client-agent: key construction", () => {
  it("swaps the agent segment, preserving workspace + secret", () => {
    const base = "brain_ws123_agent000_supersecret";
    expect(clientApiKey(base, "AGENTX")).toBe("brain_ws123_AGENTX_supersecret");
  });
  it("supportsPerClientAgent only for brain_ keys", () => {
    expect(supportsPerClientAgent("brain_a_b_c")).toBe(true);
    expect(supportsPerClientAgent("eyJ...")).toBe(false);
  });
});

// ── DB-backed: idempotent mint + usable identity ─────────────────────────────
const HAS_DB = !!process.env.DATABASE_URL;
const TEST_WS = "00000000-0000-0000-0000-0000000ca9e7";
const BASE_KEY = `brain_${TEST_WS}_00000000-0000-0000-0000-0000000000a1_localdev`;

describe.skipIf(!HAS_DB)("client-agent: provision (DB)", () => {
  beforeAll(async () => {
    const c = await getPool().connect();
    try {
      await c.query(
        `INSERT INTO workspaces (workspace_id, name, slug, plan, status, settings)
         VALUES ($1,'CA Test','ca-test','free','active','{}'::jsonb)
         ON CONFLICT (workspace_id) DO NOTHING`,
        [TEST_WS]
      );
      for (const sql of [
        `DELETE FROM chunk_extraction_status WHERE workspace_id = $1`,
        `DELETE FROM chunks WHERE workspace_id = $1`,
        `DELETE FROM memory_write_events WHERE workspace_id = $1`,
        `DELETE FROM hyobjects WHERE workspace_id = $1`,
        `DELETE FROM agents WHERE workspace_id = $1`,
      ]) { try { await c.query(sql, [TEST_WS]); } catch { /* tolerate */ } }
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    const c = await getPool().connect();
    const tol = async (s: string) => { try { await c.query(s, [TEST_WS]); } catch { /* tolerate */ } };
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

  it("creates the agent row, returns a per-client key, and is idempotent", async () => {
    const c = await getPool().connect();
    try {
      const first = await provisionClientAgent(c, BASE_KEY, "cursor");
      expect(first.agentId).toBe(clientAgentId(TEST_WS, "cursor"));
      expect(first.apiKey).toBe(`brain_${TEST_WS}_${first.agentId}_localdev`);
      expect(first.identity).toEqual({ platform: "other", display_name: "Cursor" });

      const row = await c.query(`SELECT platform, display_name FROM agents WHERE agent_id = $1`, [first.agentId]);
      expect(row.rows[0]).toEqual({ platform: "other", display_name: "Cursor" });

      // Re-running reuses the same agent (no duplicate).
      const second = await provisionClientAgent(c, BASE_KEY, "cursor");
      expect(second.agentId).toBe(first.agentId);
      const count = await c.query(`SELECT count(*)::int AS n FROM agents WHERE workspace_id = $1`, [TEST_WS]);
      expect(count.rows[0].n).toBe(1);
    } finally {
      c.release();
    }
  });

  it("the minted agent satisfies the hyobjects FK (it can actually write)", async () => {
    const c = await getPool().connect();
    let agentId: string;
    try {
      ({ agentId } = await provisionClientAgent(c, BASE_KEY, "claude-code"));
    } finally {
      c.release();
    }
    const ctx: SessionContext = { workspaceId: TEST_WS, principalRole: "agent", actorId: agentId, actorKind: "agent" };
    const res = await ingest(ctx, IngestInput.parse({ mode: "text", text: "minted-agent write probe", name: "probe", type_id: 1 }));
    expect(res.hyobject_id).toBeTruthy();
    const c2 = await getPool().connect();
    try {
      const r = await c2.query(`SELECT agent_id FROM hyobjects WHERE hyobject_id = $1`, [res.hyobject_id]);
      expect(r.rows[0].agent_id).toBe(agentId);
    } finally {
      c2.release();
    }
  });
});
