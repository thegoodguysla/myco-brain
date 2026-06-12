/**
 * brain_stats — memory health snapshot for the current workspace.
 *
 * Surfaces the quality signals that distinguish a deterministic knowledge
 * base from a noisy vector store: how much is stored, how much of the graph
 * is source-backed (has provenance), how many proposed facts are still
 * pending review, and how many writes flowed through the idempotent write
 * contract. All counts are workspace-scoped via RLS (withSession).
 *
 * Read-only. Safe to call as often as you like.
 */
import { z } from "zod";
import type pg from "pg";
import { withSession, type SessionContext } from "../db.js";

export const StatsInput = z.object({
  workspace_id: z.string().optional(),
  agent_id: z.string().optional(),
  api_key: z.string().optional(),
});

export type StatsInput = z.infer<typeof StatsInput>;

export interface StatsResult {
  workspace_id: string;
  storage: {
    documents: number;
    chunks: number;
    embedded_chunks: number;
  };
  graph: {
    entities: number;
    relations: number;
    people: number;
  };
  review: {
    entities_pending: number;
    relations_pending: number;
    entities_promoted: number;
  };
  schema: {
    // Dynamic schema (phase 1): types the extraction worker proposed from
    // observed data, awaiting manual review (schema_proposals, state=pending).
    proposed_types_pending: number;
    entity_kinds_pending: number;
    relation_types_pending: number;
    // Full dynamic schema: proposals that earned catalog promotion under the
    // corroboration rules (BRAIN_SCHEMA_AUTO_PROMOTE).
    types_auto_promoted: number;
  };
  evidence: {
    // Compounding confidence: facts backed by 2+ independent source documents,
    // facts superseded by contradiction (closed, never overwritten), and the
    // mean confidence across active graph edges.
    relations_corroborated: number;
    relations_superseded: number;
    mean_relation_confidence: number | null;
  };
  provenance: {
    proposed_facts_total: number;
    source_backed: number;
    source_backed_pct: number;
  };
  reliability: {
    memory_writes: number;
    writes_idempotency_keyed: number;
    dead_lettered: number;
  };
  agents: {
    registered: number;
    session_notes: number;
  };
  summary: string;
}

async function count(client: pg.PoolClient, sql: string): Promise<number> {
  try {
    const res = await client.query(sql);
    return Number(res.rows[0]?.n ?? 0);
  } catch {
    // A table may not exist in older self-hosted schemas — treat as zero
    // rather than failing the whole snapshot.
    return 0;
  }
}

export async function stats(
  ctx: SessionContext,
  _input: StatsInput
): Promise<StatsResult> {
  return withSession(ctx, async (client) => {
    const documents = await count(client, "SELECT count(*)::int AS n FROM hyobjects");
    const chunks = await count(client, "SELECT count(*)::int AS n FROM chunks");
    // Embeddings live in a per-provider table — sum across the known ones
    // (each count tolerates a table that doesn't exist on older schemas).
    const embeddedChunks =
      (await count(client, "SELECT count(*)::int AS n FROM chunks_openai3small")) +
      (await count(client, "SELECT count(*)::int AS n FROM chunks_ollama_nomic"));

    const entities = await count(client, "SELECT count(*)::int AS n FROM entities");
    const people = await count(client, "SELECT count(*)::int AS n FROM people");
    const relations = await count(
      client,
      `SELECT (
         (SELECT count(*) FROM entity_relations) +
         (SELECT count(*) FROM hypeoplerelations) +
         (SELECT count(*) FROM peoplerelations) +
         (SELECT count(*) FROM relatedhyperdocuments)
       )::int AS n`
    );

    const entitiesPending = await count(
      client,
      "SELECT count(*)::int AS n FROM proposed_entities WHERE promoted_entity_id IS NULL AND state = 'pending'"
    );
    const relationsPending = await count(
      client,
      "SELECT count(*)::int AS n FROM proposed_relations WHERE state = 'pending'"
    );
    const entitiesPromoted = await count(
      client,
      "SELECT count(*)::int AS n FROM proposed_entities WHERE promoted_entity_id IS NOT NULL"
    );

    // Scoped to the worker-proposed types — the table also holds legacy
    // 'hyobject_subtype' proposals from the v0.2 schema-designer flow, which
    // would otherwise inflate the "Brain proposed N new types" headline.
    const schemaTypesPending = await count(
      client,
      "SELECT count(*)::int AS n FROM schema_proposals WHERE state = 'pending' AND proposal_type IN ('entity_kind','relation_type')"
    );
    const schemaEntityKindsPending = await count(
      client,
      "SELECT count(*)::int AS n FROM schema_proposals WHERE state = 'pending' AND proposal_type = 'entity_kind'"
    );
    const schemaRelationTypesPending = await count(
      client,
      "SELECT count(*)::int AS n FROM schema_proposals WHERE state = 'pending' AND proposal_type = 'relation_type'"
    );

    const schemaTypesAutoPromoted = await count(
      client,
      "SELECT count(*)::int AS n FROM schema_proposals WHERE state = 'auto_promoted' AND proposal_type IN ('entity_kind','relation_type')"
    );

    const relationsCorroborated = await count(
      client,
      `SELECT count(*)::int AS n FROM (
         SELECT relation_row_id FROM relation_evidence
          WHERE relation_kind = 'entity_relation' AND relation_row_id IS NOT NULL
          GROUP BY relation_row_id
         HAVING COUNT(DISTINCT evidence_hyobject_id) >= 2
       ) corroborated`
    );
    const relationsSuperseded = await count(
      client,
      "SELECT count(*)::int AS n FROM entity_relations WHERE valid_to IS NOT NULL AND valid_to <= now()"
    );
    let meanRelationConfidence: number | null = null;
    try {
      const avg = await client.query(
        `SELECT round(avg(confidence), 3) AS m FROM entity_relations
          WHERE valid_to IS NULL OR valid_to > now()`
      );
      meanRelationConfidence = avg.rows[0]?.m == null ? null : Number(avg.rows[0].m);
    } catch {
      meanRelationConfidence = null;
    }

    const proposedTotal = await count(
      client,
      "SELECT count(*)::int AS n FROM proposed_entities"
    );
    const sourceBacked = await count(
      client,
      "SELECT count(*)::int AS n FROM proposed_entities WHERE source_hyobject_id IS NOT NULL"
    );
    const sourceBackedPct =
      proposedTotal > 0 ? Math.round((sourceBacked / proposedTotal) * 1000) / 10 : 100;

    const memoryWrites = await count(
      client,
      "SELECT count(*)::int AS n FROM memory_write_events"
    );
    const writesKeyed = await count(
      client,
      "SELECT count(*)::int AS n FROM memory_write_events WHERE idempotency_key IS NOT NULL"
    );
    const deadLettered = await count(
      client,
      "SELECT count(*)::int AS n FROM memory_write_events WHERE processing_status = 'dead_letter'"
    );

    const agentsRegistered = await count(client, "SELECT count(*)::int AS n FROM agents");
    const sessionNotes = await count(
      client,
      "SELECT count(*)::int AS n FROM agent_session_notes"
    );

    const schemaClause =
      schemaTypesPending > 0
        ? ` · Brain proposed ${schemaTypesPending} new type${schemaTypesPending === 1 ? "" : "s"} from your data (pending review)`
        : "";
    const evidenceClause =
      relationsCorroborated > 0 || relationsSuperseded > 0
        ? ` · evidence: ${relationsCorroborated} multi-source fact${relationsCorroborated === 1 ? "" : "s"}, ${relationsSuperseded} superseded`
        : "";

    const summary =
      `${documents} documents · ${entities + relations} graph facts ` +
      `(${entities} entities, ${relations} relations) · ` +
      `${sourceBackedPct}% of proposed facts source-backed · ` +
      `${entitiesPending + relationsPending} pending review · ` +
      `${memoryWrites} idempotent writes` +
      schemaClause +
      evidenceClause;

    return {
      workspace_id: ctx.workspaceId,
      storage: { documents, chunks, embedded_chunks: embeddedChunks },
      graph: { entities, relations, people },
      review: {
        entities_pending: entitiesPending,
        relations_pending: relationsPending,
        entities_promoted: entitiesPromoted,
      },
      schema: {
        proposed_types_pending: schemaTypesPending,
        entity_kinds_pending: schemaEntityKindsPending,
        relation_types_pending: schemaRelationTypesPending,
        types_auto_promoted: schemaTypesAutoPromoted,
      },
      evidence: {
        relations_corroborated: relationsCorroborated,
        relations_superseded: relationsSuperseded,
        mean_relation_confidence: meanRelationConfidence,
      },
      provenance: {
        proposed_facts_total: proposedTotal,
        source_backed: sourceBacked,
        source_backed_pct: sourceBackedPct,
      },
      reliability: {
        memory_writes: memoryWrites,
        writes_idempotency_keyed: writesKeyed,
        dead_lettered: deadLettered,
      },
      agents: { registered: agentsRegistered, session_notes: sessionNotes },
      summary,
    };
  });
}
