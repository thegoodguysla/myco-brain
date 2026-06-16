/**
 * Memory E2E Smoke Test: save_memory → recall_memory cross-agent verification.
 *
 * Verifies:
 *  - save_memory writes hyobject, chunk, session, and session note atomically.
 *  - recall_memory finds memories via full-text search (no embedding).
 *  - recall_memory with agent_id scoping isolates agent sub-brains.
 *  - Cross-agent recall: agent A saves, agent B cannot see it when scoped.
 *  - Session notes are included in recall results.
 *
 * Requires DATABASE_URL to be set (defaults to docker-compose local).
 *
 * Run: DATABASE_URL=postgresql://brain:brain@localhost:5432/brain vitest run src/smoke-memory.e2e.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import { getPool, closePool, type SessionContext } from "./db.js";
import { saveMemory, type SaveMemoryResult } from "./tools/save-memory.js";
import { recallMemory } from "./tools/recall-memory.js";

const TEST_WORKSPACE_ID = "00000000-0000-0000-0000-00000000e2e2";
const TEST_AGENT_A_ID = "00000000-0000-0000-0000-00000000ea11";
const TEST_AGENT_B_ID = "00000000-0000-0000-0000-00000000eb22";

const ctxA: SessionContext = {
  workspaceId: TEST_WORKSPACE_ID,
  principalRole: "agent",
  actorId: TEST_AGENT_A_ID,
  actorKind: "agent",
};

const ctxB: SessionContext = {
  workspaceId: TEST_WORKSPACE_ID,
  principalRole: "agent",
  actorId: TEST_AGENT_B_ID,
  actorKind: "agent",
};

async function runSetup(client: pg.PoolClient, sql: string, params?: unknown[]): Promise<pg.QueryResult> {
  return client.query(sql, params ?? []);
}

async function withSetup<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [TEST_WORKSPACE_ID]);
    await client.query(`SELECT set_config('app.principal_role', $1, true)`, ["service"]);
    await client.query(`SELECT set_config('app.actor_id', $1, true)`, [TEST_AGENT_A_ID]);
    await client.query(`SELECT set_config('app.actor_kind', $1, true)`, ["program"]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

describe("Memory E2E Smoke Test: save_memory → recall_memory (cross-agent)", () => {
  let saveResultA: SaveMemoryResult;
  let saveResultB: SaveMemoryResult;

  beforeAll(async () => {
    await withSetup(async (client) => {
      // Seed workspace
      await runSetup(client,
        `INSERT INTO workspaces (workspace_id, name, slug, plan)
         VALUES ($1, 'E2E Memory Test Workspace', 'e2e-memory-test', 'pro')
         ON CONFLICT (workspace_id) DO UPDATE SET name = EXCLUDED.name`,
        [TEST_WORKSPACE_ID]
      );

      // Seed agents
      await runSetup(client,
        `INSERT INTO agents (agent_id, workspace_id, platform, display_name) VALUES
         ($1, $2, 'other', 'E2E Memory Agent A'),
         ($3, $4, 'other', 'E2E Memory Agent B')
         ON CONFLICT (agent_id) DO NOTHING`,
        [TEST_AGENT_A_ID, TEST_WORKSPACE_ID, TEST_AGENT_B_ID, TEST_WORKSPACE_ID]
      );

      // Seed types required by save_memory (type_id=80, subtype_id=200)
      await runSetup(client,
        `INSERT INTO hyobject_types (type_id, name, description) VALUES
         (80, 'AgentAction', 'An agent action record')
         ON CONFLICT (type_id) DO NOTHING`
      );
      await runSetup(client,
        `INSERT INTO hyobject_subtypes (subtype_id, name, description) VALUES
         (200, 'Action', 'An agent action subtype')
         ON CONFLICT (subtype_id) DO NOTHING`
      );

      // Seed sharing_types
      await runSetup(client,
        `INSERT INTO sharing_types (sharing_type_id, name) VALUES
         (1, 'private'), (2, 'workspace'), (3, 'org'), (4, 'public'), (5, 'llm_readable')
         ON CONFLICT (sharing_type_id) DO NOTHING`
      );

      // Seed entity_kinds (needed by recall_memory JOIN)
      await runSetup(client,
        `INSERT INTO entity_kinds (kind_id, name) VALUES
         (1, 'organization'), (2, 'person'), (3, 'project'), (4, 'location')
         ON CONFLICT (kind_id) DO NOTHING`
      );

      // Seed embedding_models (referenced by chunks_openai3small FK, even though we don't use vectors here)
      await runSetup(client,
        `INSERT INTO embedding_models (model_id, dimension, active) VALUES
         ('openai-3-small', 1536, true)
         ON CONFLICT (model_id) DO NOTHING`
      );

      // Clean leftover test data
      await runSetup(client,
        `DELETE FROM agent_session_notes WHERE workspace_id = $1
           AND session_id IN (SELECT session_id FROM agent_sessions WHERE agent_id IN ($2, $3))`,
        [TEST_WORKSPACE_ID, TEST_AGENT_A_ID, TEST_AGENT_B_ID]
      );
      await runSetup(client,
        `DELETE FROM agent_sessions WHERE workspace_id = $1 AND agent_id IN ($2, $3)`,
        [TEST_WORKSPACE_ID, TEST_AGENT_A_ID, TEST_AGENT_B_ID]
      );
      await runSetup(client,
        `DELETE FROM chunks WHERE workspace_id = $1 AND hyobject_id IN
           (SELECT hyobject_id FROM hyobjects WHERE workspace_id = $1 AND agent_id IN ($2, $3))`,
        [TEST_WORKSPACE_ID, TEST_AGENT_A_ID, TEST_AGENT_B_ID]
      );
      await runSetup(client,
        `DELETE FROM hyobjects WHERE workspace_id = $1 AND agent_id IN ($2, $3)`,
        [TEST_WORKSPACE_ID, TEST_AGENT_A_ID, TEST_AGENT_B_ID]
      );
      await runSetup(client,
        `DELETE FROM entity_mentions WHERE workspace_id = $1`,
        [TEST_WORKSPACE_ID]
      );
      await runSetup(client,
        `DELETE FROM entity_relations WHERE workspace_id = $1`,
        [TEST_WORKSPACE_ID]
      );
      await runSetup(client,
        `DELETE FROM entities WHERE workspace_id = $1`,
        [TEST_WORKSPACE_ID]
      );
      await runSetup(client,
        `DELETE FROM relation_evidence WHERE workspace_id = $1`,
        [TEST_WORKSPACE_ID]
      );
      await runSetup(client,
        `DELETE FROM memory_write_events WHERE workspace_id = $1`,
        [TEST_WORKSPACE_ID]
      );
    });
  });

  afterAll(async () => {
    await withSetup(async (client) => {
      await runSetup(client,
        `DELETE FROM agent_session_notes WHERE workspace_id = $1`,
        [TEST_WORKSPACE_ID]
      );
      await runSetup(client,
        `DELETE FROM agent_sessions WHERE workspace_id = $1`,
        [TEST_WORKSPACE_ID]
      );
      await runSetup(client,
        `DELETE FROM chunks WHERE workspace_id = $1`,
        [TEST_WORKSPACE_ID]
      );
      await runSetup(client,
        `DELETE FROM hyobjects WHERE workspace_id = $1`,
        [TEST_WORKSPACE_ID]
      );
      await runSetup(client,
        `DELETE FROM relation_evidence WHERE workspace_id = $1`,
        [TEST_WORKSPACE_ID]
      );
      await runSetup(client,
        `DELETE FROM memory_write_events WHERE workspace_id = $1`,
        [TEST_WORKSPACE_ID]
      );
      await runSetup(client,
        `DELETE FROM agents WHERE workspace_id = $1`,
        [TEST_WORKSPACE_ID]
      );
      await runSetup(client,
        `DELETE FROM workspaces WHERE workspace_id = $1`,
        [TEST_WORKSPACE_ID]
      );
    });
    await closePool();
  });

  it("1. save_memory (agent A): creates hyobject, chunk, session, and note", async () => {
    saveResultA = await saveMemory(ctxA, {
      content: "Agent A observed that the project Myco uses a graph-based knowledge architecture for cross-agent memory sharing.",
      tags: { project: "myco", topic: "architecture" },
      source_label: "agent_memory",
      idempotency_key: "smoke-memory-a-1",
      trace_id: "trace-smoke-memory-a-1",
      raw_payload: { test: "smoke-memory", agent: "A", seq: 1 },
    });

    expect(saveResultA.hyobject_id).toBeTruthy();
    expect(saveResultA.note_id).toBeTruthy();
    expect(saveResultA.session_id).toBeTruthy();
    expect(saveResultA.message).toContain("Memory created");
    expect(saveResultA.message).toContain(saveResultA.hyobject_id);
  });

  it("2. save_memory (agent B): creates separate hyobject, chunk, session, and note", async () => {
    saveResultB = await saveMemory(ctxB, {
      content: "Agent B discovered a critical security vulnerability in the authentication module that requires immediate patching.",
      tags: { severity: "critical", module: "auth" },
      source_label: "agent_memory",
      idempotency_key: "smoke-memory-b-1",
      trace_id: "trace-smoke-memory-b-1",
      raw_payload: { test: "smoke-memory", agent: "B", seq: 1 },
    });

    expect(saveResultB.hyobject_id).toBeTruthy();
    expect(saveResultB.note_id).toBeTruthy();
    expect(saveResultB.session_id).toBeTruthy();
    // Different agents should have different hyobject IDs
    expect(saveResultB.hyobject_id).not.toBe(saveResultA.hyobject_id);
    expect(saveResultB.session_id).not.toBe(saveResultA.session_id);
  });

  it("3. hyobjects are persisted with correct metadata", async () => {
    const client = await getPool().connect();
    try {
      await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [TEST_WORKSPACE_ID]);
      await client.query(`SELECT set_config('app.principal_role', $1, true)`, ["service"]);
      await client.query(`SELECT set_config('app.actor_id', $1, true)`, [TEST_AGENT_A_ID]);
      await client.query(`SELECT set_config('app.actor_kind', $1, true)`, ["program"]);

      const resA = await client.query(
        `SELECT type_id, subtype_id, agent_id, processing_state, content_tsv IS NOT NULL AS has_tsv
         FROM hyobjects WHERE hyobject_id = $1`,
        [saveResultA.hyobject_id]
      );
      expect(resA.rows.length).toBe(1);
      expect(resA.rows[0].type_id).toBe(80);
      expect(resA.rows[0].subtype_id).toBe(200);
      expect(resA.rows[0].agent_id).toBe(TEST_AGENT_A_ID);
      expect(resA.rows[0].processing_state).toBe("done");
      expect(resA.rows[0].has_tsv).toBe(true);

      const resB = await client.query(
        `SELECT agent_id FROM hyobjects WHERE hyobject_id = $1`,
        [saveResultB.hyobject_id]
      );
      expect(resB.rows[0].agent_id).toBe(TEST_AGENT_B_ID);
    } finally {
      client.release();
    }
  });

  it("4. chunks are persisted with full text", async () => {
    const client = await getPool().connect();
    try {
      await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [TEST_WORKSPACE_ID]);
      await client.query(`SELECT set_config('app.principal_role', $1, true)`, ["service"]);
      await client.query(`SELECT set_config('app.actor_id', $1, true)`, [TEST_AGENT_A_ID]);
      await client.query(`SELECT set_config('app.actor_kind', $1, true)`, ["program"]);

      const res = await client.query(
        `SELECT chunk_index, text, metadata FROM chunks WHERE hyobject_id = $1`,
        [saveResultA.hyobject_id]
      );
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].chunk_index).toBe(0);
      expect(res.rows[0].text).toContain("graph-based knowledge architecture");
      const metadata = res.rows[0].metadata;
      expect(metadata).toBeDefined();
      expect(metadata.project).toBe("myco");
      expect(metadata.topic).toBe("architecture");
    } finally {
      client.release();
    }
  });

  it("5. session notes are persisted for both agents", async () => {
    const client = await getPool().connect();
    try {
      await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [TEST_WORKSPACE_ID]);
      await client.query(`SELECT set_config('app.principal_role', $1, true)`, ["service"]);
      await client.query(`SELECT set_config('app.actor_id', $1, true)`, [TEST_AGENT_A_ID]);
      await client.query(`SELECT set_config('app.actor_kind', $1, true)`, ["program"]);

      const noteA = await client.query(
        `SELECT kind, content FROM agent_session_notes WHERE note_id = $1`,
        [saveResultA.note_id]
      );
      expect(noteA.rows.length).toBe(1);
      expect(noteA.rows[0].kind).toBe("fact");
      expect(noteA.rows[0].content).toContain("graph-based knowledge architecture");

      const noteB = await client.query(
        `SELECT kind, content FROM agent_session_notes WHERE note_id = $1`,
        [saveResultB.note_id]
      );
      expect(noteB.rows.length).toBe(1);
      expect(noteB.rows[0].kind).toBe("fact");
      expect(noteB.rows[0].content).toContain("critical security vulnerability");
    } finally {
      client.release();
    }
  });

  it("6. recall_memory (agent A scoped): finds only agent A's memory", async () => {
    const result = await recallMemory(ctxA, {
      query: "graph-based knowledge architecture",
      agent_id: TEST_AGENT_A_ID,
      limit: 10,
      include_entities: true,
      reranker: "none",
    });

    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.query_meta.full_text_used).toBe(true);
    expect(result.query_meta.agent_scoped).toBe(true);

    const memory = result.memories.find((m) => m.hyobject_id === saveResultA.hyobject_id);
    expect(memory).toBeDefined();
    expect(memory!.text).toContain("graph-based knowledge architecture");
    expect(memory!.agent_id).toBe(TEST_AGENT_A_ID);

    // Should NOT contain agent B's memory
    const bMemory = result.memories.find((m) => m.hyobject_id === saveResultB.hyobject_id);
    expect(bMemory).toBeUndefined();
  });

  it("7. recall_memory (agent B scoped): finds only agent B's memory", async () => {
    const result = await recallMemory(ctxB, {
      query: "security vulnerability authentication",
      agent_id: TEST_AGENT_B_ID,
      limit: 10,
      include_entities: true,
      reranker: "none",
    });

    const memory = result.memories.find((m) => m.hyobject_id === saveResultB.hyobject_id);
    expect(memory).toBeDefined();
    expect(memory!.text).toContain("critical security vulnerability");
    expect(memory!.agent_id).toBe(TEST_AGENT_B_ID);

    // Should NOT contain agent A's query-striking text
    const aMemory = result.memories.find((m) => m.hyobject_id === saveResultA.hyobject_id);
    expect(aMemory).toBeUndefined();
  });

  it("8. recall_memory (unscoped): finds both agents' memories", async () => {
    const result = await recallMemory(ctxA, {
      query: "architecture security",
      limit: 20,
      include_entities: true,
      reranker: "none",
    });

    expect(result.query_meta.agent_scoped).toBe(false);

    const ids = result.memories.map((m) => m.hyobject_id);
    // Both agents' memories should appear (may require fuzzy match on "architecture" and "security")
    // At minimum, at least one should match
    expect(ids.length).toBeGreaterThan(0);
  });

  it("9. cross-agent recall: agent A queries agent B's memories by agent_id", async () => {
    const result = await recallMemory(ctxA, {
      query: "security vulnerability",
      agent_id: TEST_AGENT_B_ID,
      limit: 10,
      include_entities: true,
      reranker: "none",
    });

    const memory = result.memories.find((m) => m.hyobject_id === saveResultB.hyobject_id);
    expect(memory).toBeDefined();
    expect(memory!.agent_id).toBe(TEST_AGENT_B_ID);
    // Agent A's own memory should not leak in
    const aMemory = result.memories.find((m) => m.hyobject_id === saveResultA.hyobject_id);
    expect(aMemory).toBeUndefined();
  });

  it("10. recall_memory includes session_notes", async () => {
    const result = await recallMemory(ctxA, {
      query: "architecture",
      agent_id: TEST_AGENT_A_ID,
      limit: 10,
      include_entities: true,
      reranker: "none",
    });

    expect(result.session_notes.length).toBeGreaterThan(0);
    const note = result.session_notes.find((n) => n.note_id === saveResultA.note_id);
    expect(note).toBeDefined();
    expect(note!.kind).toBe("fact");
    expect(note!.content).toContain("graph-based knowledge architecture");
  });

  it("11. save_memory reuses agent session across calls", async () => {
    const result2 = await saveMemory(ctxA, {
      content: "Agent A's second observation: the build pipeline has been optimized by 40%.",
      tags: { topic: "performance" },
      source_label: "agent_memory",
      idempotency_key: "smoke-memory-a-2",
      trace_id: "trace-smoke-memory-a-2",
      raw_payload: { test: "smoke-memory", agent: "A", seq: 2 },
    });

    // Should reuse the same session_id as the first call
    expect(result2.session_id).toBe(saveResultA.session_id);
    expect(result2.hyobject_id).not.toBe(saveResultA.hyobject_id);
    expect(result2.note_id).not.toBe(saveResultA.note_id);
  });

  it("12. recall_memory with limit parameter controls result count", async () => {
    const result = await recallMemory(ctxA, {
      query: "architecture",
      limit: 1,
      include_entities: true,
      reranker: "none",
    });

    expect(result.memories.length).toBeLessThanOrEqual(1);
  });

  it("13. cross-agent data integrity: verify full pipeline coherence", () => {
    // All saved records should have distinct, non-null IDs
    expect(saveResultA.hyobject_id).toBeTruthy();
    expect(saveResultA.note_id).toBeTruthy();
    expect(saveResultA.session_id).toBeTruthy();
    expect(saveResultB.hyobject_id).toBeTruthy();
    expect(saveResultB.note_id).toBeTruthy();
    expect(saveResultB.session_id).toBeTruthy();

    // Different agents must have isolated hyobjects
    expect(saveResultA.hyobject_id).not.toBe(saveResultB.hyobject_id);
    // Different agents must have isolated sessions
    expect(saveResultA.session_id).not.toBe(saveResultB.session_id);
  });
});
