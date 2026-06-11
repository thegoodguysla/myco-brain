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
    const embeddedChunks = await count(
      client,
      "SELECT count(*)::int AS n FROM chunks_openai3small"
    );

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

    const summary =
      `${documents} documents · ${entities + relations} graph facts ` +
      `(${entities} entities, ${relations} relations) · ` +
      `${sourceBackedPct}% of proposed facts source-backed · ` +
      `${entitiesPending + relationsPending} pending review · ` +
      `${memoryWrites} idempotent writes`;

    return {
      workspace_id: ctx.workspaceId,
      storage: { documents, chunks, embedded_chunks: embeddedChunks },
      graph: { entities, relations, people },
      review: {
        entities_pending: entitiesPending,
        relations_pending: relationsPending,
        entities_promoted: entitiesPromoted,
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
