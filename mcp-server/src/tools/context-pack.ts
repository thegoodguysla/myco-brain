/**
 * brain_context_pack — primary query surface.
 *
 * Assembles a structured context bundle for a given query:
 *   - Semantic search results (top-k chunks)
 *   - Relevant entities and people
 *   - Recent agent session notes
 *   - Graph neighbourhood summary
 *
 * This is the tool agents should call first when they need information.
 */
import { z } from "zod";
import type pg from "pg";
import { withSession, type SessionContext } from "../db.js";
import { createReranker, type RerankerStrategy } from "../reranker.js";
import { embedQuery, activeEmbeddingTable } from "../embed.js";
import { compactChunksToTokenBudget } from "./context-budget.js";
import {
  computeRetrievalMetadataStats,
  type RetrievalMetadataScorable,
} from "../retrieval-metadata.js";
import {
  recordRetrievalError,
  recordRetrievalSuccess,
} from "../retrieval-observability.js";

export const ContextPackInput = z.object({
  query: z.string().min(1).describe("Natural language query"),
  embedding: z
    .array(z.number())
    .min(1)
    .optional()
    .describe(
      "Pre-computed query embedding (1536 dims for OpenAI, 768 for Ollama). " +
        "If omitted, the server embeds the query, or uses full-text only."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Max chunks to return"),
  context_token_budget: z
    .number()
    .int()
    .min(1)
    .max(200000)
    .optional()
    .describe("Optional token budget for returned chunks. Applies deterministic compaction by relevance."),
  include_entities: z.boolean().default(true),
  include_people: z.boolean().default(true),
  include_session_notes: z.boolean().default(false),
  include_relational_context: z.boolean().default(true),
  relational_limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .describe("Max relation edges to return in relational_context"),
  hyobject_types: z
    .array(z.number().int())
    .optional()
    .describe("Filter to specific hyobject type_ids"),
  reranker: z
    .enum(["none", "cohere"])
    .default("none")
    .describe(
      "Post-retrieval reranker applied after RRF fusion. " +
        "'none' keeps RRF scores. 'cohere' uses Cohere Rerank v3.5 (requires COHERE_API_KEY)."
    ),
});

export type ContextPackInput = z.infer<typeof ContextPackInput>;

export interface ContextPackResult {
  chunks: ChunkResult[];
  entities: EntityResult[];
  people: PersonResult[];
  session_notes: SessionNoteResult[];
  relational_context: RelationalContextResult;
  query_meta: { full_text_used: boolean; vector_used: boolean };
  retrieval_metadata: {
    protocol_version: "2026-05-15";
    query_mode: "full_text" | "hybrid";
    full_text_used: boolean;
    vector_used: boolean;
    reranker: RerankerStrategy;
    limit: number;
    returned_chunks: number;
    returned_entities: number;
    returned_people: number;
    returned_session_notes: number;
    returned_relational_edges: number;
    confidence_stats: {
      mean: number | null;
      min: number | null;
      max: number | null;
    };
    temporal_range: {
      earliest: string | null;
      latest: string | null;
    };
    source_statistics: {
      unique_sources: number;
      source_types: Record<number, number>;
      oldest_source: string | null;
      newest_source: string | null;
    };
    context_budget: {
      requested_budget_tokens: number | null;
      budget_applied: boolean;
      candidate_tokens: number;
      returned_tokens: number;
      dropped_chunks: number;
      truncated_chunks: number;
    };
  };
}

interface ChunkResult {
  chunk_id: string;
  hyobject_id: string;
  hyobject_name: string | null;
  hyobject_type_id: number;
  hyobject_created_at: string;
  chunk_index: number;
  text: string;
  token_count?: number | null;
  score: number;
  storage_uri: string | null;
}

interface EntityResult {
  entity_id: string;
  kind_id: number;
  canonical_name: string;
  aliases: string[];
  description: string | null;
}

interface PersonResult {
  people_id: string;
  display_name: string | null;
  primary_email: string | null;
}

interface SessionNoteResult {
  note_id: string;
  kind: string;
  content: string;
  created_at: string;
}

interface RelationalContextResult {
  edges: RelationalEdgeResult[];
  count: number;
}

interface RelationalEdgeResult {
  edge_id: string;
  relation_table: "relatedhyperdocuments" | "hypeoplerelations" | "entity_relations" | "entity_mentions";
  relation_type_id: number | null;
  predicate: string | null;
  confidence: number;
  created_at: string;
  source_hyobject_id: string | null;
  source: { id: string; kind: "hyobject" | "entity" | "person"; name: string | null };
  target: { id: string; kind: "hyobject" | "entity" | "person"; name: string | null };
}

async function getEntityMentionsCompat(
  client: pg.PoolClient
): Promise<{ pk: "id" | "mention_id"; hasHyobjectId: boolean; hasConfidence: boolean }> {
  const idRes = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'entity_mentions'
       AND column_name = 'id'
     LIMIT 1`
  );
  const hyRes = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'entity_mentions'
       AND column_name = 'hyobject_id'
     LIMIT 1`
  );
  const confRes = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'entity_mentions'
       AND column_name = 'confidence'
     LIMIT 1`
  );
  return {
    pk: idRes.rowCount && idRes.rowCount > 0 ? "id" : "mention_id",
    hasHyobjectId: Boolean(hyRes.rowCount && hyRes.rowCount > 0),
    hasConfidence: Boolean(confRes.rowCount && confRes.rowCount > 0),
  };
}

export async function contextPack(
  ctx: SessionContext,
  input: ContextPackInput
): Promise<ContextPackResult> {
  const startedAt = Date.now();
  if (!input.embedding) {
    const auto = await embedQuery(input.query);
    if (auto) input = { ...input, embedding: auto };
  }
  try {
    const out = await withSession(ctx, async (client) => {
      let chunks = await fetchChunks(client, input);

    // Apply pluggable reranker after RRF fusion
    if (input.reranker !== "none" && chunks.length > 0) {
      const reranker = createReranker(input.reranker as RerankerStrategy);
      const rerankCandidates = chunks.map((c) => ({
        id: c.chunk_id,
        text: c.text,
        score: c.score,
      }));
      const reranked = await reranker.rerank(
        input.query,
        rerankCandidates,
        input.limit
      );
      const scoreById = new Map(reranked.map((r) => [r.id, r.score]));
      chunks = chunks
        .filter((c) => scoreById.has(c.chunk_id))
        .map((c) => ({ ...c, score: scoreById.get(c.chunk_id)! }))
        .sort((a, b) => b.score - a.score);
    }
    const compaction = compactChunksToTokenBudget(chunks, input.context_token_budget);
    chunks = compaction.chunks;

    const entities = input.include_entities
      ? await fetchEntities(client, input.query)
      : [];
    const people = input.include_people
      ? await fetchPeople(client, input.query)
      : [];
    const sessionNotes = input.include_session_notes
      ? await fetchSessionNotes(client, ctx.actorId, input.query)
      : [];
    const relationalContext = input.include_relational_context
      ? await fetchRelationalContext(client, chunks, entities, people, input.relational_limit)
      : { edges: [], count: 0 };

    const metadataStats = computeRetrievalMetadataStats(
      chunks.map((c) => ({
        score: c.score,
        created_at: c.hyobject_created_at,
        hyobject_id: c.hyobject_id,
        hyobject_type_id: c.hyobject_type_id,
      }))
    );

      return {
        chunks,
        entities,
        people,
        session_notes: sessionNotes,
        relational_context: relationalContext,
        query_meta: {
          full_text_used: true,
          vector_used: !!input.embedding,
        },
        retrieval_metadata: {
          protocol_version: "2026-05-15" as const,
          query_mode: (input.embedding ? "hybrid" : "full_text") as "full_text" | "hybrid",
          full_text_used: true,
          vector_used: !!input.embedding,
          reranker: input.reranker,
          limit: input.limit,
          returned_chunks: chunks.length,
          returned_entities: entities.length,
          returned_people: people.length,
          returned_session_notes: sessionNotes.length,
          returned_relational_edges: relationalContext.count,
          confidence_stats: metadataStats.confidence_stats,
          temporal_range: metadataStats.temporal_range,
          source_statistics: metadataStats.source_statistics,
          context_budget: compaction.stats,
        },
      };
    });
    recordRetrievalSuccess("context_pack", Date.now() - startedAt);
    return out;
  } catch (err) {
    recordRetrievalError("context_pack", Date.now() - startedAt, err);
    throw err;
  }
}

async function fetchChunks(
  client: pg.PoolClient,
  input: ContextPackInput
): Promise<ChunkResult[]> {
  if (input.embedding) {
    // Hybrid search: vector similarity + full-text, RRF fusion.
    // Embeddings live in a per-provider table (chunks_openai3small / 1536 or
    // chunks_ollama_nomic / 768); name is from a fixed allowlist, not user input.
    const embedTable = activeEmbeddingTable();
    const typeFilter =
      input.hyobject_types && input.hyobject_types.length > 0
        ? `AND h.type_id = ANY($4::int[])`
        : "";

    const query = `
      WITH vector_hits AS (
        SELECT
          c.chunk_id,
          c.hyobject_id,
          c.chunk_index,
          c.text,
          1 - (cos.embedding <=> $1::vector) AS similarity,
          ROW_NUMBER() OVER (ORDER BY cos.embedding <=> $1::vector) AS rn_vec
        FROM chunks c
        JOIN ${embedTable} cos ON cos.chunk_id = c.chunk_id
        JOIN hyobjects h ON h.hyobject_id = c.hyobject_id
        WHERE h.processing_state = 'done'
          ${typeFilter}
        ORDER BY cos.embedding <=> $1::vector
        LIMIT $2
      ),
      text_hits AS (
        SELECT
          c.chunk_id,
          c.hyobject_id,
          c.chunk_index,
          c.text,
          ts_rank(h.content_tsv, replace(plainto_tsquery('english', $3)::text, '&', '|')::tsquery) AS rank,
          ROW_NUMBER() OVER (ORDER BY ts_rank(h.content_tsv, replace(plainto_tsquery('english', $3)::text, '&', '|')::tsquery) DESC) AS rn_text
        FROM chunks c
        JOIN hyobjects h ON h.hyobject_id = c.hyobject_id
        WHERE h.content_tsv @@ replace(plainto_tsquery('english', $3)::text, '&', '|')::tsquery
          AND h.processing_state = 'done'
          ${typeFilter}
        ORDER BY rank DESC
        LIMIT $2
      ),
      rrf AS (
        SELECT
          COALESCE(v.chunk_id, t.chunk_id) AS chunk_id,
          COALESCE(v.hyobject_id, t.hyobject_id) AS hyobject_id,
          COALESCE(v.chunk_index, t.chunk_index) AS chunk_index,
          COALESCE(v.text, t.text) AS text,
          COALESCE(1.0 / (60.0 + v.rn_vec), 0) +
          COALESCE(1.0 / (60.0 + t.rn_text), 0) AS rrf_score
        FROM vector_hits v
        FULL OUTER JOIN text_hits t ON t.chunk_id = v.chunk_id
      )
      SELECT
        r.chunk_id,
        r.hyobject_id,
        h.name AS hyobject_name,
        h.type_id AS hyobject_type_id,
        h.created_at AS hyobject_created_at,
        r.chunk_index,
        r.text,
        c.token_count,
        r.rrf_score AS score,
        h.storage_uri
      FROM rrf r
      JOIN hyobjects h ON h.hyobject_id = r.hyobject_id
      ORDER BY rrf_score DESC
      LIMIT $2
    `;

    const params: unknown[] = [
      `[${input.embedding.join(",")}]`,
      input.limit,
      input.query,
    ];
    if (input.hyobject_types && input.hyobject_types.length > 0) {
      params.push(input.hyobject_types);
    }

    const res = await client.query(query, params);
    return res.rows as ChunkResult[];
  }

  // Full-text only.
  // OR semantics: plainto_tsquery ANDs every word, so a natural multi-word
  // question returns nothing unless one chunk contains all stems. Swapping its
  // '&' for '|' lets chunks matching *some* terms surface, ranked by ts_rank.
  // plainto_tsquery still parses/stems/strips stopwords, so this is
  // injection-safe. Must match the WHERE and ts_rank expressions. (Same fix as
  // search.ts fullTextSearch.)
  const typeFilter =
    input.hyobject_types && input.hyobject_types.length > 0
      ? `AND h.type_id = ANY($3::int[])`
      : "";

  const query = `
    SELECT
      c.chunk_id,
      c.hyobject_id,
      h.name AS hyobject_name,
      h.type_id AS hyobject_type_id,
      h.created_at AS hyobject_created_at,
      c.chunk_index,
      c.text,
      c.token_count,
      ts_rank(h.content_tsv, replace(plainto_tsquery('english', $1)::text, '&', '|')::tsquery) AS score,
      h.storage_uri
    FROM chunks c
    JOIN hyobjects h ON h.hyobject_id = c.hyobject_id
    WHERE h.content_tsv @@ replace(plainto_tsquery('english', $1)::text, '&', '|')::tsquery
      AND h.processing_state = 'done'
      ${typeFilter}
    ORDER BY score DESC
    LIMIT $2
  `;

  const params: unknown[] = [input.query, input.limit];
  if (input.hyobject_types && input.hyobject_types.length > 0) {
    params.push(input.hyobject_types);
  }

  const res = await client.query(query, params);
  return res.rows as ChunkResult[];
}

async function fetchEntities(
  client: pg.PoolClient,
  query: string
): Promise<EntityResult[]> {
  const res = await client.query(
    `SELECT entity_id, kind_id, canonical_name, aliases, description
     FROM entities
     WHERE canonical_name ILIKE '%' || $1 || '%'
        OR aliases @> ARRAY[$1]
     LIMIT 10`,
    [query]
  );
  return res.rows as EntityResult[];
}

async function fetchPeople(
  client: pg.PoolClient,
  query: string
): Promise<PersonResult[]> {
  const res = await client.query(
    `SELECT people_id, display_name, primary_email
     FROM people
     WHERE display_name ILIKE '%' || $1 || '%'
        OR primary_email ILIKE '%' || $1 || '%'
     LIMIT 10`,
    [query]
  );
  return res.rows as PersonResult[];
}

async function fetchSessionNotes(
  client: pg.PoolClient,
  agentId: string,
  query: string
): Promise<SessionNoteResult[]> {
  const res = await client.query(
    `SELECT n.note_id, n.kind, n.content, n.created_at
     FROM agent_session_notes n
     JOIN agent_sessions s ON s.session_id = n.session_id
     WHERE s.agent_id = $1
       AND n.content ILIKE '%' || $2 || '%'
     ORDER BY n.created_at DESC
     LIMIT 5`,
    [agentId, query]
  );
  return res.rows as SessionNoteResult[];
}

async function fetchRelationalContext(
  client: pg.PoolClient,
  chunks: ChunkResult[],
  entities: EntityResult[],
  people: PersonResult[],
  limit: number
): Promise<RelationalContextResult> {
  const entityMentions = await getEntityMentionsCompat(client);
  const hyobjectIds = Array.from(new Set(chunks.map((c) => c.hyobject_id)));
  const entityIds = Array.from(new Set(entities.map((e) => e.entity_id)));
  const peopleIds = Array.from(new Set(people.map((p) => p.people_id)));

  if (hyobjectIds.length === 0 && entityIds.length === 0 && peopleIds.length === 0) {
    return { edges: [], count: 0 };
  }

  const seeds: Array<{
    edge_id: string;
    relation_table: RelationalEdgeResult["relation_table"];
    relation_type_id: number | null;
    predicate: string | null;
    confidence: number;
    created_at: string;
    source_hyobject_id: string | null;
    source_id: string;
    source_kind: "hyobject" | "entity" | "person";
    target_id: string;
    target_kind: "hyobject" | "entity" | "person";
  }> = [];

  if (hyobjectIds.length > 0) {
    const hh = await client.query(
      `SELECT id, relation_type_id, confidence, created_at, hyobject1_id, hyobject2_id
       FROM relatedhyperdocuments
       WHERE hyobject1_id = ANY($1::uuid[])
          OR hyobject2_id = ANY($1::uuid[])
       ORDER BY created_at DESC
       LIMIT $2`,
      [hyobjectIds, limit]
    );
    for (const row of hh.rows) {
      seeds.push({
        edge_id: row.id,
        relation_table: "relatedhyperdocuments",
        relation_type_id: row.relation_type_id,
        predicate: null,
        confidence: Number(row.confidence),
        created_at: row.created_at,
        source_hyobject_id: null,
        source_id: row.hyobject1_id,
        source_kind: "hyobject",
        target_id: row.hyobject2_id,
        target_kind: "hyobject",
      });
    }

    const hp = await client.query(
      `SELECT id, relation_type_id, confidence, created_at, source_hyobject_id, hyobject_id, people_id
       FROM hypeoplerelations
       WHERE hyobject_id = ANY($1::uuid[])
          ${peopleIds.length > 0 ? "OR people_id = ANY($2::uuid[])" : ""}
       ORDER BY created_at DESC
       LIMIT $${peopleIds.length > 0 ? 3 : 2}`,
      peopleIds.length > 0 ? [hyobjectIds, peopleIds, limit] : [hyobjectIds, limit]
    );
    for (const row of hp.rows) {
      seeds.push({
        edge_id: row.id,
        relation_table: "hypeoplerelations",
        relation_type_id: row.relation_type_id,
        predicate: null,
        confidence: Number(row.confidence),
        created_at: row.created_at,
        source_hyobject_id: row.source_hyobject_id ?? null,
        source_id: row.hyobject_id,
        source_kind: "hyobject",
        target_id: row.people_id,
        target_kind: "person",
      });
    }
  } else if (peopleIds.length > 0) {
    const hp = await client.query(
      `SELECT id, relation_type_id, confidence, created_at, source_hyobject_id, hyobject_id, people_id
       FROM hypeoplerelations
       WHERE people_id = ANY($1::uuid[])
       ORDER BY created_at DESC
       LIMIT $2`,
      [peopleIds, limit]
    );
    for (const row of hp.rows) {
      seeds.push({
        edge_id: row.id,
        relation_table: "hypeoplerelations",
        relation_type_id: row.relation_type_id,
        predicate: null,
        confidence: Number(row.confidence),
        created_at: row.created_at,
        source_hyobject_id: row.source_hyobject_id ?? null,
        source_id: row.hyobject_id,
        source_kind: "hyobject",
        target_id: row.people_id,
        target_kind: "person",
      });
    }
  }

  if (entityIds.length > 0) {
    const ee = await client.query(
      `SELECT id, confidence, created_at, predicate, source_hyobject_id, entity1_id, entity2_id
       FROM entity_relations
       WHERE entity1_id = ANY($1::uuid[])
          OR entity2_id = ANY($1::uuid[])
       ORDER BY created_at DESC
       LIMIT $2`,
      [entityIds, limit]
    );
    for (const row of ee.rows) {
      seeds.push({
        edge_id: row.id,
        relation_table: "entity_relations",
        relation_type_id: null,
        predicate: row.predicate ?? null,
        confidence: Number(row.confidence),
        created_at: row.created_at,
        source_hyobject_id: row.source_hyobject_id ?? null,
        source_id: row.entity1_id,
        source_kind: "entity",
        target_id: row.entity2_id,
        target_kind: "entity",
      });
    }

    const mention = entityMentions.hasHyobjectId
      ? await client.query(
          `SELECT ${entityMentions.pk} AS edge_id, confidence, created_at, entity_id, hyobject_id
           FROM entity_mentions
           WHERE entity_id = ANY($1::uuid[])
              ${hyobjectIds.length > 0 ? "OR hyobject_id = ANY($2::uuid[])" : ""}
           ORDER BY created_at DESC
           LIMIT $${hyobjectIds.length > 0 ? 3 : 2}`,
          hyobjectIds.length > 0 ? [entityIds, hyobjectIds, limit] : [entityIds, limit]
        )
      : await client.query(
          `SELECT em.${entityMentions.pk} AS edge_id, ${entityMentions.hasConfidence ? "em.confidence" : "1.0"} AS confidence, em.created_at, em.entity_id, c.hyobject_id
           FROM entity_mentions em
           JOIN chunks c ON c.chunk_id = em.chunk_id
           WHERE em.entity_id = ANY($1::uuid[])
              ${hyobjectIds.length > 0 ? "OR c.hyobject_id = ANY($2::uuid[])" : ""}
           ORDER BY em.created_at DESC
           LIMIT $${hyobjectIds.length > 0 ? 3 : 2}`,
          hyobjectIds.length > 0 ? [entityIds, hyobjectIds, limit] : [entityIds, limit]
        );
    for (const row of mention.rows) {
      seeds.push({
        edge_id: row.edge_id,
        relation_table: "entity_mentions",
        relation_type_id: null,
        predicate: "mentions",
        confidence: Number(row.confidence),
        created_at: row.created_at,
        source_hyobject_id: row.hyobject_id ?? null,
        source_id: row.hyobject_id,
        source_kind: "hyobject",
        target_id: row.entity_id,
        target_kind: "entity",
      });
    }
  } else if (hyobjectIds.length > 0) {
    const mention = entityMentions.hasHyobjectId
      ? await client.query(
          `SELECT ${entityMentions.pk} AS edge_id, confidence, created_at, entity_id, hyobject_id
           FROM entity_mentions
           WHERE hyobject_id = ANY($1::uuid[])
           ORDER BY created_at DESC
           LIMIT $2`,
          [hyobjectIds, limit]
        )
      : await client.query(
          `SELECT em.${entityMentions.pk} AS edge_id, ${entityMentions.hasConfidence ? "em.confidence" : "1.0"} AS confidence, em.created_at, em.entity_id, c.hyobject_id
           FROM entity_mentions em
           JOIN chunks c ON c.chunk_id = em.chunk_id
           WHERE c.hyobject_id = ANY($1::uuid[])
           ORDER BY em.created_at DESC
           LIMIT $2`,
          [hyobjectIds, limit]
        );
    for (const row of mention.rows) {
      seeds.push({
        edge_id: row.edge_id,
        relation_table: "entity_mentions",
        relation_type_id: null,
        predicate: "mentions",
        confidence: Number(row.confidence),
        created_at: row.created_at,
        source_hyobject_id: row.hyobject_id ?? null,
        source_id: row.hyobject_id,
        source_kind: "hyobject",
        target_id: row.entity_id,
        target_kind: "entity",
      });
    }
  }

  const ordered = seeds
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, limit);

  const uniqueHyobjectIds = Array.from(
    new Set(
      ordered
        .flatMap((s) => [
          s.source_kind === "hyobject" ? s.source_id : null,
          s.target_kind === "hyobject" ? s.target_id : null,
        ])
        .filter((v): v is string => typeof v === "string")
    )
  );
  const uniqueEntityIds = Array.from(
    new Set(
      ordered
        .flatMap((s) => [
          s.source_kind === "entity" ? s.source_id : null,
          s.target_kind === "entity" ? s.target_id : null,
        ])
        .filter((v): v is string => typeof v === "string")
    )
  );
  const uniquePersonIds = Array.from(
    new Set(
      ordered
        .flatMap((s) => [
          s.source_kind === "person" ? s.source_id : null,
          s.target_kind === "person" ? s.target_id : null,
        ])
        .filter((v): v is string => typeof v === "string")
    )
  );

  const nameMap = new Map<string, string | null>();
  if (uniqueHyobjectIds.length > 0) {
    const res = await client.query(
      `SELECT hyobject_id, name
       FROM hyobjects
       WHERE hyobject_id = ANY($1::uuid[])`,
      [uniqueHyobjectIds]
    );
    for (const row of res.rows) {
      nameMap.set(row.hyobject_id, row.name ?? null);
    }
  }
  if (uniqueEntityIds.length > 0) {
    const res = await client.query(
      `SELECT entity_id, canonical_name
       FROM entities
       WHERE entity_id = ANY($1::uuid[])`,
      [uniqueEntityIds]
    );
    for (const row of res.rows) {
      nameMap.set(row.entity_id, row.canonical_name ?? null);
    }
  }
  if (uniquePersonIds.length > 0) {
    const res = await client.query(
      `SELECT people_id, display_name
       FROM people
       WHERE people_id = ANY($1::uuid[])`,
      [uniquePersonIds]
    );
    for (const row of res.rows) {
      nameMap.set(row.people_id, row.display_name ?? null);
    }
  }

  const edges: RelationalEdgeResult[] = ordered.map((s) => ({
    edge_id: s.edge_id,
    relation_table: s.relation_table,
    relation_type_id: s.relation_type_id,
    predicate: s.predicate,
    confidence: s.confidence,
    created_at: s.created_at,
    source_hyobject_id: s.source_hyobject_id,
    source: {
      id: s.source_id,
      kind: s.source_kind,
      name: nameMap.get(s.source_id) ?? null,
    },
    target: {
      id: s.target_id,
      kind: s.target_kind,
      name: nameMap.get(s.target_id) ?? null,
    },
  }));

  return {
    edges,
    count: edges.length,
  };
}
