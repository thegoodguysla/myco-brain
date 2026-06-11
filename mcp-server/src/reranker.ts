/**
 * Pluggable reranker abstraction for Brain search.
 *
 * Rerankers run AFTER initial retrieval (pgvector + BM25/RRF) to apply
 * an additional reranking pass for improved precision.
 *
 * Available strategies:
 *   - 'none'   — pass-through, no reranking (default, preserves existing behaviour)
 *   - 'cohere' — Cohere Rerank v3.5 API (requires COHERE_API_KEY env var)
 */

export type RerankerStrategy = "none" | "cohere";

export interface RerankCandidate {
  id: string; // chunk_id
  text: string;
  score: number; // upstream score (BM25 hybrid / RRF)
}

export interface Reranker {
  /**
   * Rerank candidates based on the query.
   * Returns up to `limit` results sorted by relevance descending.
   */
  rerank(
    query: string,
    candidates: RerankCandidate[],
    limit: number
  ): Promise<RerankCandidate[]>;
}

/**
 * PassThroughReranker — sorts by upstream score, no additional API call.
 * Used as the default when reranker is 'none'.
 */
export class PassThroughReranker implements Reranker {
  async rerank(
    _query: string,
    candidates: RerankCandidate[],
    limit: number
  ): Promise<RerankCandidate[]> {
    return [...candidates].sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

/**
 * CohereReranker — Cohere Rerank v3.5 API.
 *
 * Sends candidate texts to Cohere and replaces upstream scores with
 * Cohere relevance scores. Requires COHERE_API_KEY environment variable.
 *
 * Cost: ~$2/1M tokens. Best quality/cost tradeoff among external rerankers.
 */
export class CohereReranker implements Reranker {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(model = "rerank-v3.5") {
    const key = process.env.COHERE_API_KEY;
    if (!key) {
      throw new Error(
        "CohereReranker requires COHERE_API_KEY environment variable"
      );
    }
    this.apiKey = key;
    this.model = model;
  }

  async rerank(
    query: string,
    candidates: RerankCandidate[],
    limit: number
  ): Promise<RerankCandidate[]> {
    if (candidates.length === 0) return [];

    const response = await fetch("https://api.cohere.com/v2/rerank", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents: candidates.map((c) => c.text),
        top_n: limit,
        return_documents: false,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Cohere rerank failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as {
      results: { index: number; relevance_score: number }[];
    };

    return data.results.map((r) => ({
      ...candidates[r.index],
      score: r.relevance_score,
    }));
  }
}

/**
 * Create a Reranker from a strategy name.
 * Falls back to PassThroughReranker on unknown strategy.
 */
export function createReranker(strategy: RerankerStrategy): Reranker {
  switch (strategy) {
    case "cohere":
      return new CohereReranker();
    case "none":
    default:
      return new PassThroughReranker();
  }
}
