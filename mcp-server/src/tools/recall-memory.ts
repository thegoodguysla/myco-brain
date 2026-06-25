/**
 * brain_recall_memory — agent-scoped semantic recall.
 *
 * Searches the Myco knowledge graph for content relevant to the query,
 * optionally scoped to a specific agent's sub-brain. Returns chunks,
 * entities, and session notes in a simplified format.
 *
 * This is a convenience wrapper around brain_context_pack with
 * agent scoping and session_notes enabled by default.
 */
import { z } from "zod";
import type pg from "pg";
import { withSession, type SessionContext } from "../db.js";
import { createReranker, type RerankerStrategy } from "../reranker.js";
import { activeEmbeddingTable } from "../embed.js";
import { hyobjectVisibleSql } from "../sharing.js";
import { type AttributionHint } from "../attribution.js";
import { computeAttribution } from "../attribution-db.js";
import {
  resolveSourceAgents,
  attachSourceAgent,
  type SourceAgent,
} from "../agent-provenance.js";

export const RecallMemoryInput = z.object({
  query: z.string().min(1).describe("Natural language query for recall"),
  embedding: z
    .array(z.number())
    .min(1)
    .optional()
    .describe(
      "Pre-computed query embedding (1536 dims for OpenAI, 768 for Ollama). " +
        "If omitted, full-text search only."
    ),
  agent_id: z
    .string()
    .optional()
    .describe("Scope recall to a specific agent's memories. If omitted, searches all agents."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Max results to return"),
  include_entities: z.boolean().default(true),
  reranker: z
    .enum(["none", "cohere"])
    .default("none")
    .describe("Post-retrieval reranker. 'cohere' uses Cohere Rerank v3.5."),
});

export type RecallMemoryInput = z.infer<typeof RecallMemoryInput>;

export interface RecallMemoryResult {
  memories: MemoryChunk[];
  entities: EntityHit[];
  session_notes: SessionNoteHit[];
  query_meta: { full_text_used: boolean; vector_used: boolean; agent_scoped: boolean };
  // Structured "recalled from your memory" credit, or null when the workspace has
  // matured past the decay threshold. Surfaced via the agent contract, never the
  // result body. See attribution.ts.
  attribution?: AttributionHint | null;
}

interface MemoryChunk {
  hyobject_id: string;
  name: string | null;
  text: string;
  score: number;
  agent_id: string | null;
  // Which client/agent saved this memory ("Claude Code", "Cursor"), or null when
  // unknown. Lets the agent surface "this came from Cursor". See agent-provenance.
  source_agent?: SourceAgent | null;
}

interface EntityHit {
  entity_id: string;
  canonical_name: string;
  kind: string;
  description: string | null;
}

interface SessionNoteHit {
  note_id: string;
  kind: string;
  content: string;
  created_at: string;
}

export async function recallMemory(
  ctx: SessionContext,
  input: RecallMemoryInput
): Promise<RecallMemoryResult> {
  return withSession(ctx, async (client) => {
    const chunks = await fetchMemoryChunks(client, input);

    let finalChunks = chunks;
    if (input.reranker !== "none" && chunks.length > 0) {
      const reranker = createReranker(input.reranker as RerankerStrategy);
      const candidates = chunks.map((c) => ({ id: c.hyobject_id, text: c.text, score: c.score }));
      const reranked = await reranker.rerank(input.query, candidates, input.limit);
      const scoreById = new Map(reranked.map((r) => [r.id, r.score]));
      finalChunks = chunks
        .filter((c) => scoreById.has(c.hyobject_id))
        .map((c) => ({ ...c, score: scoreById.get(c.hyobject_id)! }))
        .sort((a, b) => b.score - a.score)
        .slice(0, input.limit);
    }

    const entities = input.include_entities
      ? await fetchEntityHits(client, input.query)
      : [];

    const sessionNotes = await fetchSessionNotesScoped(
      client,
      ctx.actorId,
      input.agent_id ?? ctx.actorId,
      input.query
    );

    const returned = finalChunks.slice(0, input.limit);
    // Stamp each memory with the agent that saved it, and let attribution name a
    // cross-agent source on the top hit ("…from Cursor's memory").
    const sourceAgents = await resolveSourceAgents(
      client,
      ctx.workspaceId,
      returned.map((c) => c.agent_id)
    );
    const memories = attachSourceAgent(returned, sourceAgents);
    const attribution = await computeAttribution(client, ctx.workspaceId, returned[0], ctx.actorId);

    return {
      memories,
      entities,
      session_notes: sessionNotes,
      query_meta: {
        full_text_used: true,
        vector_used: !!input.embedding,
        agent_scoped: !!input.agent_id,
      },
      attribution,
    };
  });
}


async function fetchMemoryChunks(
  client: pg.PoolClient,
  input: RecallMemoryInput
): Promise<MemoryChunk[]> {
  const embeddingParam = input.embedding ? `[${input.embedding.join(",")}]` : null;

  if (embeddingParam && input.embedding) {
    const hasAgentScope = Boolean(input.agent_id);
    const agentFilter = hasAgentScope
      ? `AND h.agent_id = $2`
      : `AND h.agent_id IS NOT NULL`;
    const limitParam = hasAgentScope ? "$3" : "$2";
    const queryParam = hasAgentScope ? "$4" : "$3";

    const query = `
      WITH vector_hits AS (
        SELECT
          c.hyobject_id,
          h.name,
          c.text,
          1 - (cos.embedding <=> $1::vector) AS similarity,
          h.agent_id
        FROM chunks c
        JOIN ${activeEmbeddingTable()} cos ON cos.chunk_id = c.chunk_id
        JOIN hyobjects h ON h.hyobject_id = c.hyobject_id AND ${hyobjectVisibleSql("h")}
        WHERE h.processing_state = 'done'
          ${agentFilter}
        ORDER BY cos.embedding <=> $1::vector
        LIMIT ${limitParam}
      ),
      text_hits AS (
        SELECT
          h.hyobject_id,
          h.name,
          c.text,
          ts_rank(h.content_tsv, replace(plainto_tsquery(${queryParam})::text, '&', '|')::tsquery) AS rank,
          h.agent_id
        FROM hyobjects h
        JOIN chunks c ON c.hyobject_id = h.hyobject_id AND ${hyobjectVisibleSql("h")}
        WHERE h.content_tsv @@ replace(plainto_tsquery(${queryParam})::text, '&', '|')::tsquery
          AND h.processing_state = 'done'
          ${agentFilter}
        ORDER BY rank DESC
        LIMIT ${limitParam}
      )
      SELECT
        COALESCE(v.hyobject_id, t.hyobject_id) AS hyobject_id,
        COALESCE(v.name, t.name) AS name,
        COALESCE(v.text, t.text) AS text,
        COALESCE(1.0 / (60.0 + ROW_NUMBER() OVER (ORDER BY v.similarity DESC NULLS LAST)), 0) +
        COALESCE(1.0 / (60.0 + ROW_NUMBER() OVER (ORDER BY t.rank DESC NULLS LAST)), 0) AS score,
        COALESCE(v.agent_id, t.agent_id) AS agent_id
      FROM vector_hits v
      FULL OUTER JOIN text_hits t ON t.hyobject_id = v.hyobject_id
      ORDER BY score DESC
      LIMIT ${limitParam}
    `;

    const params: unknown[] = hasAgentScope
      ? [embeddingParam, input.agent_id, input.limit, input.query]
      : [embeddingParam, input.limit, input.query];
    const res = await client.query(query, params);
    return res.rows as MemoryChunk[];
  }

  const hasAgentScope = Boolean(input.agent_id);
  const agentFilter = hasAgentScope
    ? `AND h.agent_id = $2`
    : `AND h.agent_id IS NOT NULL`;
  const limitParam = hasAgentScope ? "$3" : "$2";

  // Full-text only.
  // OR semantics (see search.ts / context-pack.ts): plainto_tsquery ANDs every
  // word, so a multi-word recall returns nothing unless one chunk has all
  // stems. Swapping '&' for '|' surfaces partial matches, ranked by ts_rank.
  const query = `
    SELECT
      h.hyobject_id,
      h.name,
      c.text,
      ts_rank(h.content_tsv, replace(plainto_tsquery($1)::text, '&', '|')::tsquery) AS score,
      h.agent_id
    FROM hyobjects h
    JOIN chunks c ON c.hyobject_id = h.hyobject_id AND ${hyobjectVisibleSql("h")}
    WHERE h.content_tsv @@ replace(plainto_tsquery($1)::text, '&', '|')::tsquery
      AND h.processing_state = 'done'
      ${agentFilter}
    ORDER BY score DESC
    LIMIT ${limitParam}
  `;

  const params: unknown[] = hasAgentScope
    ? [input.query, input.agent_id, input.limit]
    : [input.query, input.limit];
  const res = await client.query(query, params);
  return res.rows as MemoryChunk[];
}

async function fetchEntityHits(
  client: pg.PoolClient,
  query: string
): Promise<EntityHit[]> {
  const res = await client.query(
    `SELECT e.entity_id, e.canonical_name, ek.name AS kind, e.description
     FROM entities e
     JOIN entity_kinds ek USING (kind_id)
     WHERE e.canonical_name ILIKE '%' || $1 || '%'
        OR e.aliases @> ARRAY[$1]
     LIMIT 10`,
    [query]
  );
  return res.rows as EntityHit[];
}

async function fetchSessionNotesScoped(
  client: pg.PoolClient,
  callerAgentId: string,
  targetAgentId: string,
  query: string
): Promise<SessionNoteHit[]> {
  const res = await client.query(
    `SELECT n.note_id, n.kind, n.content, n.created_at
     FROM agent_session_notes n
     JOIN agent_sessions s ON s.session_id = n.session_id
     WHERE s.agent_id = $1
       AND n.content ILIKE '%' || $2 || '%'
     ORDER BY n.created_at DESC
     LIMIT 10`,
    [targetAgentId, query]
  );
  return res.rows as SessionNoteHit[];
}
