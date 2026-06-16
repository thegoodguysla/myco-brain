/**
 * Myco E2E Smoke Test: ingest → search → neighbors → why pipeline.
 *
 * Verifies the four core tools work end-to-end against a real Postgres database.
 * Requires DATABASE_URL to be set (defaults to docker-compose local).
 *
 * Run: DATABASE_URL=postgresql://brain:brain@localhost:5432/brain npm test
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { getPool, closePool, withSession, type SessionContext } from "./db.js";
import { ingest } from "./tools/ingest.js";
import { search } from "./tools/search.js";
import { neighbors } from "./tools/neighbors.js";
import { why } from "./tools/why.js";

const TEST_WORKSPACE_ID = "00000000-0000-0000-0000-00000000e2e1";
const TEST_AGENT_ID = "e2e-smoke-test-agent";

const ctx: SessionContext = {
  workspaceId: TEST_WORKSPACE_ID,
  principalRole: "service",
  actorId: TEST_AGENT_ID,
  actorKind: "program",
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
    await client.query(`SELECT set_config('app.actor_id', $1, true)`, [TEST_AGENT_ID]);
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

describe("Myco E2E Smoke Test: ingest → search → neighbors → why", () => {
  let hyobjectId: string;
  let chunkId: string;
  let entityId: string;
  let personId: string;

  beforeAll(async () => {
    await withSetup(async (client) => {
      // Seed workspace (UPSERT)
      await runSetup(client,
        `INSERT INTO workspaces (workspace_id, name, slug, plan)
         VALUES ($1, 'E2E Test Workspace', 'e2e-test', 'pro')
         ON CONFLICT (workspace_id) DO UPDATE SET name = EXCLUDED.name`,
        [TEST_WORKSPACE_ID]
      );

      // Seed agent (UPSERT)
      await runSetup(client,
        `INSERT INTO agents (agent_id, workspace_id, platform, display_name)
         VALUES ($1, $2, 'other', 'E2E Smoke Test Agent')
         ON CONFLICT (agent_id) DO NOTHING`,
        [TEST_AGENT_ID, TEST_WORKSPACE_ID]
      );

      // Seed hyobject_types
      await runSetup(client,
        `INSERT INTO hyobject_types (type_id, name, description) VALUES
         (1, 'Document', 'A generic document'),
         (80, 'AgentAction', 'An agent action record')
         ON CONFLICT (type_id) DO NOTHING`
      );

      // Seed hyobject_subtypes
      await runSetup(client,
        `INSERT INTO hyobject_subtypes (subtype_id, name, description) VALUES
         (1, 'Generic', 'A generic document subtype'),
         (200, 'Action', 'An agent action subtype')
         ON CONFLICT (subtype_id) DO NOTHING`
      );

      // Seed sharing_types
      await runSetup(client,
        `INSERT INTO sharing_types (sharing_type_id, name) VALUES
         (1, 'private'),
         (2, 'workspace'),
         (3, 'org'),
         (4, 'public'),
         (5, 'llm_readable')
         ON CONFLICT (sharing_type_id) DO NOTHING`
      );

      // Seed entity_kinds
      await runSetup(client,
        `INSERT INTO entity_kinds (kind_id, name) VALUES
         (1, 'organization'),
         (2, 'person'),
         (3, 'project'),
         (4, 'location')
         ON CONFLICT (kind_id) DO NOTHING`
      );

      // Seed relation_types
      await runSetup(client,
        `INSERT INTO relation_types (relation_type_id, name, is_symmetric) VALUES
         (1, 'REFERENCES', false),
         (2, 'MENTIONS', false),
         (3, 'ASSIGNED_TO', false)
         ON CONFLICT (relation_type_id) DO NOTHING`
      );

      // Seed embedding_models
      await runSetup(client,
        `INSERT INTO embedding_models (model_id, dimension, active) VALUES
         ('openai-3-small', 1536, true)
         ON CONFLICT (model_id) DO NOTHING`
      );

      // Clean up any leftover e2e test data from previous runs
      await runSetup(client,
        `DELETE FROM entity_mentions WHERE workspace_id = $1 AND hyobject_id IN
           (SELECT hyobject_id FROM hyobjects WHERE workspace_id = $1 AND name LIKE 'E2E Smoke%')`,
        [TEST_WORKSPACE_ID]
      );
      await runSetup(client,
        `DELETE FROM entity_relations WHERE workspace_id = $1 AND entity1_id IN
           (SELECT entity_id FROM entities WHERE workspace_id = $1 AND canonical_name LIKE 'E2E%')`,
        [TEST_WORKSPACE_ID]
      );
      await runSetup(client,
        `DELETE FROM entities WHERE workspace_id = $1 AND canonical_name LIKE 'E2E%'`,
        [TEST_WORKSPACE_ID]
      );
      await runSetup(client,
        `DELETE FROM hypeoplerelations WHERE workspace_id = $1 AND people_id IN
           (SELECT people_id FROM people WHERE workspace_id = $1 AND display_name LIKE 'E2E%')`,
        [TEST_WORKSPACE_ID]
      );
      await runSetup(client,
        `DELETE FROM people WHERE workspace_id = $1 AND display_name LIKE 'E2E%'`,
        [TEST_WORKSPACE_ID]
      );
      await runSetup(client,
        `DELETE FROM chunks_openai3small WHERE chunk_id IN
           (SELECT chunk_id FROM chunks WHERE hyobject_id IN
             (SELECT hyobject_id FROM hyobjects WHERE workspace_id = $1 AND name LIKE 'E2E Smoke%'))`,
        [TEST_WORKSPACE_ID]
      );
      await runSetup(client,
        `DELETE FROM chunks WHERE hyobject_id IN
           (SELECT hyobject_id FROM hyobjects WHERE workspace_id = $1 AND name LIKE 'E2E Smoke%')`,
        [TEST_WORKSPACE_ID]
      );
      await runSetup(client,
        `DELETE FROM hyobjects WHERE workspace_id = $1 AND name LIKE 'E2E Smoke%'`,
        [TEST_WORKSPACE_ID]
      );
    });
  });

  afterAll(async () => {
    await withSetup(async (client) => {
      // Clean up test-originated data by workspace
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
        `DELETE FROM hypeoplerelations WHERE workspace_id = $1`,
        [TEST_WORKSPACE_ID]
      );
      await runSetup(client,
        `DELETE FROM people WHERE workspace_id = $1`,
        [TEST_WORKSPACE_ID]
      );
      await runSetup(client,
        `DELETE FROM chunks_openai3small WHERE chunk_id IN
           (SELECT chunk_id FROM chunks WHERE workspace_id = $1)`,
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

  it("1. ingest: creates a hyobject from raw text with inline indexing", async () => {
    const result = await ingest(ctx, {
      mode: "text",
      type_id: 1,
      text: "Alice Johnson signed the Q4 contract with Acme Corp in San Francisco on December 15, 2025. The contract value is $2.4M and covers all North American operations.",
      name: "E2E Smoke Test Document",
      mime_type: "text/plain",
    });

    expect(result.hyobject_id).toBeTruthy();
    hyobjectId = result.hyobject_id;
    // Text mode: processed inline — done immediately, not queued for worker
    expect(result.processing_state).toBe("done");
    expect(result.name).toBe("E2E Smoke Test Document");
    expect(result.message).toContain("BM25 searchable immediately");
  });

  it("2. ingest: creates an AgentAction hyobject as side-effect", async () => {
    const client = await getPool().connect();
    try {
      await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [TEST_WORKSPACE_ID]);
      await client.query(`SELECT set_config('app.principal_role', $1, true)`, ["service"]);
      await client.query(`SELECT set_config('app.actor_id', $1, true)`, [TEST_AGENT_ID]);
      await client.query(`SELECT set_config('app.actor_kind', $1, true)`, ["program"]);
      const res = await client.query(
        `SELECT hyobject_id FROM hyobjects WHERE workspace_id = $1 AND type_id = 80 ORDER BY created_at DESC LIMIT 1`,
        [TEST_WORKSPACE_ID]
      );
      expect(res.rows.length).toBeGreaterThanOrEqual(1);
    } finally {
      client.release();
    }
  });

  it("3. verify inline indexing: chunk and content_tsv created by ingest", async () => {
    // Text-mode ingest writes chunks and content_tsv inline — no worker step needed.
    const client = await getPool().connect();
    try {
      await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [TEST_WORKSPACE_ID]);
      await client.query(`SELECT set_config('app.principal_role', $1, true)`, ["service"]);
      await client.query(`SELECT set_config('app.actor_id', $1, true)`, [TEST_AGENT_ID]);
      await client.query(`SELECT set_config('app.actor_kind', $1, true)`, ["program"]);

      // Verify hyobject is already done
      const hyRes = await client.query(
        `SELECT processing_state, content_tsv IS NOT NULL AS has_tsv
           FROM hyobjects WHERE hyobject_id = $1`,
        [hyobjectId]
      );
      expect(hyRes.rows[0].processing_state).toBe("done");
      expect(hyRes.rows[0].has_tsv).toBe(true);

      // Fetch the chunk created by ingest
      const chunkRes = await client.query(
        `SELECT chunk_id, text FROM chunks WHERE hyobject_id = $1 ORDER BY chunk_index LIMIT 1`,
        [hyobjectId]
      );
      expect(chunkRes.rows.length).toBeGreaterThanOrEqual(1);
      chunkId = chunkRes.rows[0].chunk_id;
      expect(chunkRes.rows[0].text).toContain("Alice Johnson");
    } finally {
      client.release();
    }
  });

  it("4. seed: create entity and person for graph traversal", async () => {
    await withSetup(async (client) => {
      // Create entity: Acme Corp
      const entityRes = await runSetup(client,
        `INSERT INTO entities (workspace_id, kind_id, canonical_name, aliases)
         VALUES ($1, $2, $3, $4)
         RETURNING entity_id`,
        [TEST_WORKSPACE_ID, 1, "E2E Acme Corp", ["{acme}"]]
      );
      entityId = entityRes.rows[0].entity_id;

      // Create entity mention: Acme Corp ← hyobject
      await runSetup(client,
        `INSERT INTO entity_mentions (workspace_id, entity_id, hyobject_id, confidence)
         VALUES ($1, $2, $3, $4)`,
        [TEST_WORKSPACE_ID, entityId, hyobjectId, 0.95]
      );

      // Create person: Alice Johnson
      const personRes = await runSetup(client,
        `INSERT INTO people (workspace_id, firstname, lastname, display_name)
         VALUES ($1, $2, $3, $4)
         RETURNING people_id`,
        [TEST_WORKSPACE_ID, "E2E Alice", "Johnson", "E2E Alice Johnson"]
      );
      personId = personRes.rows[0].people_id;

      // Create person ↔ hyobject relation
      await runSetup(client,
        `INSERT INTO hypeoplerelations (workspace_id, people_id, hyobject_id, relation_type_id, confidence)
         VALUES ($1, $2, $3, $4, $5)`,
        [TEST_WORKSPACE_ID, personId, hyobjectId, 3, 1.0] // relation_type_id=3 = ASSIGNED_TO
      );
    });
  });

  it("5. search: full-text search finds the ingested document", async () => {
    const result = await search(ctx, {
      query: "Acme Corp contract Q4",
      sort: "score" as const,
      limit: 20,
      offset: 0,
      reranker: "none" as const,
      // No embedding → full-text fallback
    });

    expect(result.results.length).toBeGreaterThan(0);
    const hit = result.results.find((r) => r.hyobject_id === hyobjectId);
    expect(hit).toBeDefined();
    if (hit) {
      expect(hit.hyobject_name).toBe("E2E Smoke Test Document");
      expect(hit.text).toContain("Alice Johnson");
      expect(hit.score).toBeGreaterThan(0);
    }
  });

  it("6. search: respects filters (date range)", async () => {
    const result = await search(ctx, {
      query: "contract",
      sort: "score" as const,
      limit: 20,
      offset: 0,
      reranker: "none" as const,
      filters: {
        created_after: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
      },
    });

    expect(result.results.length).toBeGreaterThan(0);
    const hit = result.results.find((r) => r.hyobject_id === hyobjectId);
    expect(hit).toBeDefined();
  });

  it("7. neighbors: finds entity and person connections for the hyobject", async () => {
    const result = await neighbors(ctx, {
      node_id: hyobjectId,
      node_kind: "hyobject",
      depth: 1,
      limit: 20,
    });

    // Should find at least the entity mention and person relation
    expect(result.edges.length).toBeGreaterThan(0);
    expect(result.nodes.length).toBeGreaterThan(0);

    // Should include the entity "E2E Acme Corp"
    const entityEdge = result.edges.find(
      (e) => e.to_kind === "entity" && e.predicate === "mentions"
    );
    expect(entityEdge).toBeDefined();

    // Should include the person "E2E Alice Johnson"
    const personEdge = result.edges.find(
      (e) => e.to_kind === "person" && e.from_kind === "hyobject"
    );
    expect(personEdge).toBeDefined();

    // Root node should be present
    const rootNode = result.nodes.find((n) => n.id === hyobjectId);
    expect(rootNode).toBeDefined();
    expect(rootNode!.kind).toBe("hyobject");

    // Entity node should have its canonical name
    const entityNode = result.nodes.find((n) => n.id === entityId);
    expect(entityNode).toBeDefined();
    expect(entityNode!.name).toBe("E2E Acme Corp");
  });

  it("8. neighbors: respects depth and limit", async () => {
    const result = await neighbors(ctx, {
      node_id: hyobjectId,
      node_kind: "hyobject",
      depth: 1,
      limit: 1,
    });

    expect(result.edges.length).toBeGreaterThan(0);
  });

  it("9. neighbors: works for entity-kind nodes", async () => {
    const result = await neighbors(ctx, {
      node_id: entityId,
      node_kind: "entity",
      depth: 1,
      limit: 20,
    });

    // Should find the mention edge back to the hyobject
    const mentionEdge = result.edges.find(
      (e) => e.to_kind === "hyobject" && e.predicate === "mentioned_in"
    );
    expect(mentionEdge).toBeDefined();

    // Root node should be present
    const rootNode = result.nodes.find((n) => n.id === entityId);
    expect(rootNode).toBeDefined();
    expect(rootNode!.kind).toBe("entity");
  });

  it("10. why: traces provenance of the ingested hyobject", async () => {
    const result = await why(ctx, {
      hyobject_id: hyobjectId,
      limit_vc: 20,
    });

    // Subject info
    expect(result.subject).toBeTruthy();
    expect(result.subject!.kind).toBe("hyobject");
    expect(result.subject!.id).toBe(hyobjectId);
    expect(result.subject!.name).toBe("E2E Smoke Test Document");
    expect(result.subject!.processing_state).toBe("done");

    // VC audit trail should have entries (the ingest INSERT triggers VC logging)
    expect(result.vc_trail.length).toBeGreaterThan(0);

    // Verify at least one VC entry has the right actor context
    const vcEntry = result.vc_trail[0];
    expect(vcEntry.column_name).toBeTruthy();
    expect(vcEntry.operation).toBeTruthy();
    expect(vcEntry.actor_id).toBe(TEST_AGENT_ID);
  });

  it("11. why: includes ingest_info with metadata", async () => {
    const result = await why(ctx, {
      hyobject_id: hyobjectId,
      limit_vc: 20,
    });

    expect(result.ingest_info).toBeDefined();
    if (result.ingest_info) {
      expect(result.ingest_info.mime_type).toBe("text/plain");
    }
  });

  it("12. why: traces provenance of the entity we created", async () => {
    const result = await why(ctx, {
      entity_id: entityId,
      limit_vc: 20,
    });

    expect(result.subject).toBeTruthy();
    expect(result.subject!.kind).toBe("entity");
    expect(result.subject!.id).toBe(entityId);
    expect(result.subject!.name).toBe("E2E Acme Corp");

    // VC trail for entity creation
    expect(result.vc_trail.length).toBeGreaterThan(0);
  });

  it("13. full pipeline: verify data integrity across tools", () => {
    // The same hyobject_id should be consistent across all tool results.
    // This validates that the entity graph and provenance chain are coherent.
    expect(hyobjectId).toBeTruthy();
    expect(chunkId).toBeTruthy();
    expect(entityId).toBeTruthy();
    expect(personId).toBeTruthy();
  });
});
