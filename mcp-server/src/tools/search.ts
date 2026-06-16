/**
 * brain_search — hybrid search with BM25 re-ranking and closet_boost.
 *
 * Pipeline (when embedding is provided):
 *   1. Over-fetch 3x candidates from pgvector (cosine similarity)
 *   2. BM25 re-rank over candidates (Lucene-style IDF, candidate-set denominator)
 *   3. Closet boost: rank-based bonus for chunks whose entity index matches query
 *   4. Final score: 0.6 * vec_sim + 0.4 * bm25_norm + closet_boost
 *   5. Return top-N sorted by final score
 *
 * Without embedding: falls back to full-text search (ts_rank), no BM25/boost.
 *
 * Supports structured filters: type_id, people_id, entity_id, date range.
 */
import { z } from "zod";
import type pg from "pg";
import { withSession, type SessionContext } from "../db.js";
import { embedQuery, activeEmbeddingTable } from "../embed.js";
import {
  tokenize,
  bm25Scores,
  minMaxNormalize,
  hybridScore,
  CLOSET_BOOST_RANKS,
} from "../bm25.js";
import { createReranker, type RerankerStrategy } from "../reranker.js";
import {
  computeRetrievalMetadataStats,
  type RetrievalMetadataScorable,
} from "../retrieval-metadata.js";
import {
  recordRetrievalError,
  recordRetrievalSuccess,
} from "../retrieval-observability.js";
import { hyobjectVisibleSql } from "../sharing.js";

export const SearchInput = z.object({
  query: z.string().min(1),
  embedding: z
    .array(z.number())
    .min(1)
    .max(4096)
    .optional()
    .describe(
      "Pre-computed query embedding (must match the server's embedding " +
        "provider dimension: 1536 for OpenAI, 768 for Ollama). If omitted, the " +
        "server embeds the query itself, or falls back to full-text."
    ),
  filters: z
    .object({
      type_ids: z.array(z.number().int()).optional(),
      people_ids: z.array(z.string().uuid()).optional(),
      entity_ids: z.array(z.string().uuid()).optional(),
      created_after: z.string().datetime().optional(),
      created_before: z.string().datetime().optional(),
    })
    .optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
  sort: z.enum(["score", "date_desc", "date_asc"]).default("score"),
  reranker: z
    .enum(["none", "cohere", "recency"])
    .default("none")
    .describe(
      "Post-retrieval reranker. 'none' preserves BM25 hybrid scores. " +
        "'recency' blends relevance with recency (keyless, no API). " +
        "'cohere' applies Cohere Rerank v3.5 (requires COHERE_API_KEY)."
    ),
});

export type SearchInput = z.infer<typeof SearchInput>;

export interface SearchResult {
  results: SearchHit[];
  total_estimated: number;
  retrieval_metadata: {
    protocol_version: "2026-05-15";
    query_mode: "full_text" | "hybrid";
    full_text_used: boolean;
    vector_used: boolean;
    reranker: RerankerStrategy;
    limit: number;
    offset: number;
    sort: "score" | "date_desc" | "date_asc";
    candidate_count: number;
    returned_count: number;
    overfetch_factor: number | null;
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
  };
}

export interface SearchHit {
  chunk_id: string;
  hyobject_id: string;
  hyobject_name: string | null;
  type_id: number;
  chunk_index: number;
  text: string;
  score: number;
  created_at: string;
  storage_uri: string | null;
}

// How many times more candidates to fetch for BM25 re-ranking
const OVERFETCH_FACTOR = 3;

export async function search(
  ctx: SessionContext,
  input: SearchInput
): Promise<SearchResult> {
  const startedAt = Date.now();
  if (!input.embedding) {
    const auto = await embedQuery(input.query);
    if (auto) input = { ...input, embedding: auto };
  }
  try {
    const out = await withSession(ctx, async (client) => {
      if (!input.embedding) {
        return fullTextSearch(client, input);
      }
      return hybridSearch(client, input);
    });
    recordRetrievalSuccess("search", Date.now() - startedAt);
    return out;
  } catch (err) {
    recordRetrievalError("search", Date.now() - startedAt, err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Hybrid search: pgvector → BM25 re-rank → closet_boost
// ---------------------------------------------------------------------------

async function hybridSearch(
  client: pg.PoolClient,
  input: SearchInput
): Promise<SearchResult> {
  const candidateLimit =
    (input.limit + input.offset) * OVERFETCH_FACTOR;

  const conditions: string[] = ["h.processing_state = 'done'"];
  const params: unknown[] = [];
  let pIdx = 1;

  // Vector embedding param
  params.push(`[${input.embedding!.join(",")}]`);
  const vecParam = pIdx++;

  if (input.filters?.type_ids?.length) {
    params.push(input.filters.type_ids);
    conditions.push(`h.type_id = ANY($${pIdx++}::int[])`);
  }

  if (input.filters?.created_after) {
    params.push(input.filters.created_after);
    conditions.push(`h.created_at >= $${pIdx++}::timestamptz`);
  }

  if (input.filters?.created_before) {
    params.push(input.filters.created_before);
    conditions.push(`h.created_at <= $${pIdx++}::timestamptz`);
  }

  if (input.filters?.people_ids?.length) {
    params.push(input.filters.people_ids);
    conditions.push(`EXISTS (
      SELECT 1 FROM hypeoplerelations hpr
      WHERE hpr.hyobject_id = h.hyobject_id
        AND hpr.people_id = ANY($${pIdx++}::uuid[])
    )`);
  }

  if (input.filters?.entity_ids?.length) {
    params.push(input.filters.entity_ids);
    conditions.push(`EXISTS (
      SELECT 1 FROM entity_mentions em
      WHERE em.hyobject_id = h.hyobject_id
        AND em.entity_id = ANY($${pIdx++}::uuid[])
    )`);
  }

  params.push(candidateLimit);
  const limitParam = pIdx++;

  const whereClause = conditions.join(" AND ");

  // Embeddings live in a per-provider table (chunks_openai3small / 1536 or
  // chunks_ollama_nomic / 768). Name is from a fixed allowlist, not user input.
  const embedTable = activeEmbeddingTable();

  // Step 1: fetch over-sampled candidate set from pgvector
  const candidateSql = `
    SELECT
      c.chunk_id,
      c.hyobject_id,
      h.name AS hyobject_name,
      h.type_id,
      c.chunk_index,
      c.text,
      1 - (cos.embedding <=> $${vecParam}::vector) AS vec_sim,
      h.created_at,
      h.storage_uri
    FROM chunks c
    JOIN hyobjects h ON h.hyobject_id = c.hyobject_id AND ${hyobjectVisibleSql("h")}
    JOIN ${embedTable} cos ON cos.chunk_id = c.chunk_id
    WHERE ${whereClause}
    ORDER BY cos.embedding <=> $${vecParam}::vector
    LIMIT $${limitParam}
  `;

  const candidateRes = await client.query(candidateSql, params);
  const candidates = candidateRes.rows as (SearchHit & { vec_sim: number })[];

  if (candidates.length === 0) {
    return {
      results: [],
      total_estimated: 0,
      retrieval_metadata: {
        protocol_version: "2026-05-15",
        query_mode: "hybrid",
        full_text_used: true,
        vector_used: true,
        reranker: input.reranker,
        limit: input.limit,
        offset: input.offset,
        sort: input.sort,
        candidate_count: 0,
        returned_count: 0,
        overfetch_factor: OVERFETCH_FACTOR,
        confidence_stats: { mean: null, min: null, max: null },
        temporal_range: { earliest: null, latest: null },
        source_statistics: {
          unique_sources: 0,
          source_types: {},
          oldest_source: null,
          newest_source: null,
        },
      },
    };
  }

  // Step 2: BM25 over the candidate set
  const queryTokens = tokenize(input.query);
  const corpus = candidates.map((c) => ({ id: c.chunk_id, text: c.text }));
  const rawBm25 = bm25Scores(queryTokens, corpus);
  const normBm25 = minMaxNormalize(rawBm25);

  // Step 3: closet_boost from entity index
  const chunkIds = candidates.map((c) => c.chunk_id);
  const boosts = await fetchClosetBoosts(client, input.query, chunkIds);

  // Step 4: blend scores — `let` so the reranker step can reassign
  let scored = candidates.map((c) => ({
    ...c,
    score:
      hybridScore(c.vec_sim, normBm25.get(c.chunk_id) ?? 0) +
      (boosts.get(c.chunk_id) ?? 0),
  }));

  // Step 5: rerank (optional) then sort and paginate
  if (input.sort === "score") {
    if (input.reranker !== "none") {
      // Apply pluggable reranker over BM25+closet_boost scored candidates
      const reranker = createReranker(input.reranker as RerankerStrategy);
      const rerankCandidates = scored.map((c) => ({
        id: c.chunk_id,
        text: c.text,
        score: c.score,
        createdAt: c.created_at,
      }));
      const reranked = await reranker.rerank(
        input.query,
        rerankCandidates,
        input.offset + input.limit
      );
      // Rebuild scored array in reranker order, preserving full hit metadata
      const scoreById = new Map(reranked.map((r) => [r.id, r.score]));
      scored = scored
        .filter((c) => scoreById.has(c.chunk_id))
        .map((c) => ({ ...c, score: scoreById.get(c.chunk_id)! }))
        .sort((a, b) => b.score - a.score);
    } else {
      scored.sort((a, b) => b.score - a.score);
    }
  } else if (input.sort === "date_desc") {
    scored.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  } else {
    scored.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
  }

  const page = scored.slice(input.offset, input.offset + input.limit);
  const metadataStats = computeRetrievalMetadataStats(
    page.map((c) => ({
      score: c.score,
      created_at: c.created_at,
      hyobject_id: c.hyobject_id,
      hyobject_type_id: c.type_id,
    })) satisfies RetrievalMetadataScorable[]
  );

  return {
    results: page.map(({ vec_sim: _v, ...hit }) => hit),
    total_estimated: candidates.length,
    retrieval_metadata: {
      protocol_version: "2026-05-15",
      query_mode: "hybrid",
      full_text_used: true,
      vector_used: true,
      reranker: input.reranker,
      limit: input.limit,
      offset: input.offset,
      sort: input.sort,
      candidate_count: candidates.length,
      returned_count: page.length,
      overfetch_factor: OVERFETCH_FACTOR,
      confidence_stats: metadataStats.confidence_stats,
      temporal_range: metadataStats.temporal_range,
      source_statistics: metadataStats.source_statistics,
    },
  };
}

// ---------------------------------------------------------------------------
// Closet boost: rank-based boost from entity index
// ---------------------------------------------------------------------------

/**
 * For each entity whose canonical_name or aliases overlap with the query,
 * find which candidate chunks mention it. Apply CLOSET_BOOST_RANKS by entity rank.
 *
 * Max 5 entities are considered (one boost slot per rank).
 */
async function fetchClosetBoosts(
  client: pg.PoolClient,
  query: string,
  chunkIds: string[]
): Promise<Map<string, number>> {
  const boosts = new Map<string, number>();
  if (chunkIds.length === 0) return boosts;

  // Find entities that appear in the query text (match canonical_name or any alias)
  // We use ILIKE with each token for broad coverage
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return boosts;

  // Build an OR predicate for all tokens against canonical_name and aliases
  const tokenConditions = queryTokens
    .map((_, i) => `canonical_name ILIKE $${i + 1} OR aliases @> ARRAY[$${i + 1}]`)
    .join(" OR ");

  const entityParams: string[] = queryTokens.map((t) => `%${t}%`);

  const entityRes = await client.query(
    `SELECT entity_id
     FROM entities
     WHERE ${tokenConditions}
     ORDER BY char_length(canonical_name) DESC
     LIMIT ${CLOSET_BOOST_RANKS.length}`,
    entityParams
  );

  if (entityRes.rows.length === 0) return boosts;

  const rankedEntityIds: string[] = entityRes.rows.map(
    (r: { entity_id: string }) => r.entity_id
  );

  // For each ranked entity, find which candidate chunks mention it
  // entity_mentions links entity_id → hyobject_id; we match via chunks.hyobject_id
  for (let rank = 0; rank < rankedEntityIds.length; rank++) {
    const boost = CLOSET_BOOST_RANKS[rank];
    const entityId = rankedEntityIds[rank];

    const mentionRes = await client.query(
      `SELECT c.chunk_id
       FROM chunks c
       JOIN entity_mentions em ON em.hyobject_id = c.hyobject_id
       WHERE em.entity_id = $1
         AND c.chunk_id = ANY($2::uuid[])`,
      [entityId, chunkIds]
    );

    for (const row of mentionRes.rows as { chunk_id: string }[]) {
      boosts.set(row.chunk_id, (boosts.get(row.chunk_id) ?? 0) + boost);
    }
  }

  return boosts;
}

// ---------------------------------------------------------------------------
// Full-text fallback (no embedding)
// ---------------------------------------------------------------------------

async function fullTextSearch(
  client: pg.PoolClient,
  input: SearchInput
): Promise<SearchResult> {
  const conditions: string[] = ["h.processing_state = 'done'"];
  const params: unknown[] = [];
  let pIdx = 1;

  params.push(input.query);
  const ftParam = pIdx++;
  // Use OR semantics for the no-embedding full-text path. plainto_tsquery ANDs
  // every word, so a natural question ("what pricing did we choose and why")
  // returns nothing unless one document contains all of those stems. Swapping
  // its '&' operators for '|' lets a document matching *some* terms surface,
  // ranked by ts_rank below. plainto_tsquery still does the parsing/stemming/
  // stopword removal, so this is injection-safe.
  conditions.push(
    `h.content_tsv @@ replace(plainto_tsquery('english', $${ftParam})::text, '&', '|')::tsquery`
  );

  if (input.filters?.type_ids?.length) {
    params.push(input.filters.type_ids);
    conditions.push(`h.type_id = ANY($${pIdx++}::int[])`);
  }

  if (input.filters?.created_after) {
    params.push(input.filters.created_after);
    conditions.push(`h.created_at >= $${pIdx++}::timestamptz`);
  }

  if (input.filters?.created_before) {
    params.push(input.filters.created_before);
    conditions.push(`h.created_at <= $${pIdx++}::timestamptz`);
  }

  if (input.filters?.people_ids?.length) {
    params.push(input.filters.people_ids);
    conditions.push(`EXISTS (
      SELECT 1 FROM hypeoplerelations hpr
      WHERE hpr.hyobject_id = h.hyobject_id
        AND hpr.people_id = ANY($${pIdx++}::uuid[])
    )`);
  }

  if (input.filters?.entity_ids?.length) {
    params.push(input.filters.entity_ids);
    conditions.push(`EXISTS (
      SELECT 1 FROM entity_mentions em
      WHERE em.hyobject_id = h.hyobject_id
        AND em.entity_id = ANY($${pIdx++}::uuid[])
    )`);
  }

  const whereClause = conditions.join(" AND ");

  const orderClause =
    input.sort === "score"
      ? `ORDER BY score DESC`
      : input.sort === "date_desc"
        ? `ORDER BY h.created_at DESC`
        : `ORDER BY h.created_at ASC`;

  params.push(input.limit);
  const limitParam = pIdx++;
  params.push(input.offset);
  const offsetParam = pIdx++;

  const sql = `
    SELECT
      c.chunk_id,
      c.hyobject_id,
      h.name AS hyobject_name,
      h.type_id,
      c.chunk_index,
      c.text,
      ts_rank(h.content_tsv, replace(plainto_tsquery('english', $${ftParam})::text, '&', '|')::tsquery) AS score,
      h.created_at,
      h.storage_uri
    FROM chunks c
    JOIN hyobjects h ON h.hyobject_id = c.hyobject_id AND ${hyobjectVisibleSql("h")}
    WHERE ${whereClause}
    ${orderClause}
    LIMIT $${limitParam}
    OFFSET $${offsetParam}
  `;

  const res = await client.query(sql, params);

  const countSql = `
    SELECT COUNT(*) AS cnt
    FROM chunks c
    JOIN hyobjects h ON h.hyobject_id = c.hyobject_id AND ${hyobjectVisibleSql("h")}
    WHERE ${whereClause}
  `;
  const countParams = params.slice(0, params.length - 2);
  const countRes = await client.query(countSql, countParams);

  let results = res.rows as SearchHit[];

  // Apply pluggable reranker when sort=score and reranker≠none
  if (input.sort === "score" && input.reranker !== "none") {
    const reranker = createReranker(input.reranker as RerankerStrategy);
    const rerankCandidates = results.map((r) => ({
      id: r.chunk_id,
      text: r.text,
      score: r.score,
    }));
    const reranked = await reranker.rerank(
      input.query,
      rerankCandidates,
      results.length
    );
    const scoreById = new Map(reranked.map((r) => [r.id, r.score]));
    results = results
      .filter((r) => scoreById.has(r.chunk_id))
      .map((r) => ({ ...r, score: scoreById.get(r.chunk_id)! }))
      .sort((a, b) => b.score - a.score);
  }
  const metadataFtStats = computeRetrievalMetadataStats(
    results.map((r) => ({
      score: r.score,
      created_at: r.created_at,
      hyobject_id: r.hyobject_id,
      hyobject_type_id: r.type_id,
    })) satisfies RetrievalMetadataScorable[]
  );

  return {
    results,
    total_estimated: parseInt(countRes.rows[0].cnt, 10),
    retrieval_metadata: {
      protocol_version: "2026-05-15",
      query_mode: "full_text",
      full_text_used: true,
      vector_used: false,
      reranker: input.reranker,
      limit: input.limit,
      offset: input.offset,
      sort: input.sort,
      candidate_count: results.length,
      returned_count: results.length,
      overfetch_factor: null,
      confidence_stats: metadataFtStats.confidence_stats,
      temporal_range: metadataFtStats.temporal_range,
      source_statistics: metadataFtStats.source_statistics,
    },
  };
}
