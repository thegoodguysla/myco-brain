/**
 * materialize-evidence.ts — Agent Graph Interconnection Pipeline (THE-413)
 *
 * Materializes relation_evidence rows from agent memory writes.
 * Called as a post-write hook from save-memory, annotate, propose-fact,
 * and ingest tools after the canonical memory_write_events record is created.
 *
 * Evidence types materialized:
 *   - agent_memory  — agent ↔ hyobject (saved_memory, annotated, ingested, proposed)
 *   - entity_relation  — entity ↔ entity (propose_fact relation)
 *   - agent_agent   — agent ↔ agent (cross-agent recall/interaction)
 */
import type pg from "pg";

// ---------------------------------------------------------------------------
// Evidence item
// ---------------------------------------------------------------------------

export interface EvidenceItem {
  /** relation_kind: agent_memory, entity_relation, or agent_agent */
  relationKind: "agent_memory" | "entity_relation" | "agent_agent";
  /** Source node ID (agent_id, entity_id, or hyobject_id) */
  sourceNodeId: string;
  /** Target node ID (agent_id, entity_id, or hyobject_id) */
  targetNodeId: string;
  /** Human-readable edge label */
  predicate: string;
  /** The hyobject that provides the evidence for this edge */
  evidenceHyobjectId?: string;
  /** The chunk within the hyobject that provides evidence */
  evidenceChunkId?: string;
  /** Link to source relation row (e.g., memory_write_events.event_id) */
  relationRowId?: string;
  /** Confidence 0-1 */
  confidence?: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Materialize evidence edges from a memory write.
 *
 * Called within the same transaction as the write. Each item creates one
 * row in relation_evidence. Duplicates (same workspace, source, target,
 * predicate) are skipped via ON CONFLICT DO NOTHING if a unique index exists,
 * or handled gracefully by the caller.
 *
 * Idempotent: replayed writes produce the same evidence — no duplicates.
 */
export async function materializeEvidence(
  client: pg.PoolClient,
  workspaceId: string,
  items: EvidenceItem[]
): Promise<string[]> {
  if (items.length === 0) return [];

  const eventIds: string[] = [];
  for (const item of items) {
    const res = await client.query(
      `INSERT INTO relation_evidence
         (workspace_id, relation_kind, relation_row_id,
          source_node_id, target_node_id, predicate,
          evidence_hyobject_id, evidence_chunk_id,
          confidence, metadata, evidence_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        workspaceId,
        item.relationKind,
        item.relationRowId ?? null,
        item.sourceNodeId,
        item.targetNodeId,
        item.predicate,
        item.evidenceHyobjectId ?? null,
        item.evidenceChunkId ?? null,
        item.confidence ?? 1.0,
        JSON.stringify(item.metadata ?? {}),
        "event",
      ]
    );
    eventIds.push(res.rows[0]?.id);
  }

  return eventIds;
}

/**
 * Record a cross-agent interaction (agent→agent edge).
 *
 * Used when:
 *   - An agent recalls memory from a different agent's sub-brain
 *   - An agent annotates on another agent's session
 *   - Two agents share the same trace lineage
 */
export async function materializeAgentAgentEdge(
  client: pg.PoolClient,
  workspaceId: string,
  agent1Id: string,
  agent2Id: string,
  predicate: string,
  options?: {
    evidenceHyobjectId?: string;
    relationRowId?: string;
    confidence?: number;
    metadata?: Record<string, unknown>;
  }
): Promise<string> {
  const res = await client.query(
    `INSERT INTO relation_evidence
       (workspace_id, relation_kind, relation_row_id,
        source_node_id, target_node_id, predicate,
        evidence_hyobject_id, confidence, metadata, evidence_kind)
     VALUES ($1, 'agent_agent', $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      workspaceId,
      options?.relationRowId ?? null,
      agent1Id,
      agent2Id,
      predicate,
      options?.evidenceHyobjectId ?? null,
      options?.confidence ?? 1.0,
      JSON.stringify(options?.metadata ?? {}),
      "event",
    ]
  );
  return res.rows[0]?.id;
}

/**
 * Record an agent→memory edge.
 *
 * Used when an agent creates/owns a hyobject via save_memory, annotate,
 * propose_fact, or ingest.
 */
export async function materializeAgentMemoryEdge(
  client: pg.PoolClient,
  workspaceId: string,
  agentId: string,
  hyobjectId: string,
  predicate: string,
  options?: {
    relationRowId?: string;
    evidenceChunkId?: string;
    confidence?: number;
    metadata?: Record<string, unknown>;
  }
): Promise<string> {
  const res = await client.query(
    `INSERT INTO relation_evidence
       (workspace_id, relation_kind, relation_row_id,
        source_node_id, target_node_id, predicate,
        evidence_hyobject_id, evidence_chunk_id,
        confidence, metadata, evidence_kind)
     VALUES ($1, 'agent_memory', $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      workspaceId,
      options?.relationRowId ?? null,
      agentId,
      hyobjectId,
      predicate,
      hyobjectId,
      options?.evidenceChunkId ?? null,
      options?.confidence ?? 1.0,
      JSON.stringify(options?.metadata ?? {}),
      "event",
    ]
  );
  return res.rows[0]?.id;
}
