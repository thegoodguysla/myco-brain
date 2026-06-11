/**
 * BM25 hybrid re-ranker — ported from MemPalace searcher.py.
 *
 * Design:
 *   - Lucene-style IDF over the candidate set (not global corpus)
 *   - Min-max normalize BM25 so it's commensurable with cosine similarity
 *   - Closet boost: rank-based boost from a secondary entity index
 *
 * Final score: 0.6 * vec_sim + 0.4 * bm25_norm  (+ optional closet_boost)
 */

// BM25 hyperparameters (Lucene defaults)
const K1 = 1.5;
const B = 0.75;

// Closet boost values by entity rank (0-indexed, max 5 entities)
export const CLOSET_BOOST_RANKS = [0.4, 0.25, 0.15, 0.08, 0.04] as const;

// Weight coefficients
export const VEC_WEIGHT = 0.6;
export const BM25_WEIGHT = 0.4;

/**
 * Simple whitespace + punctuation tokenizer.
 * Lowercases and drops tokens shorter than 2 chars.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/**
 * Compute raw BM25 scores for each document in `docs` against `queryTokens`.
 * The IDF denominator is the candidate set size (N), not the full corpus.
 */
export function bm25Scores(
  queryTokens: string[],
  docs: { id: string; text: string }[]
): Map<string, number> {
  const N = docs.length;
  const scores = new Map<string, number>();
  if (N === 0 || queryTokens.length === 0) return scores;

  // Tokenize all docs once
  const tokenizedDocs = docs.map((doc) => ({
    id: doc.id,
    tokens: tokenize(doc.text),
  }));

  // Average document length
  const avgLen =
    tokenizedDocs.reduce((sum, d) => sum + d.tokens.length, 0) / N;

  // Document frequency per query term in the candidate set
  const df = new Map<string, number>();
  for (const qt of queryTokens) {
    let count = 0;
    for (const doc of tokenizedDocs) {
      if (doc.tokens.some((t) => t === qt)) count++;
    }
    df.set(qt, count);
  }

  // BM25 per document
  for (const doc of tokenizedDocs) {
    const len = doc.tokens.length;
    let score = 0;

    // Pre-count term frequencies for this doc
    const tfMap = new Map<string, number>();
    for (const t of doc.tokens) tfMap.set(t, (tfMap.get(t) ?? 0) + 1);

    for (const qt of queryTokens) {
      const tf = tfMap.get(qt) ?? 0;
      if (tf === 0) continue;

      const docFreq = df.get(qt) ?? 0;
      // Lucene-style smoothed IDF
      const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
      // TF normalization with length correction
      const tfNorm =
        (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (len / avgLen)));
      score += idf * tfNorm;
    }

    scores.set(doc.id, score);
  }

  return scores;
}

/**
 * Min-max normalize a score map to [0, 1].
 * If all scores are equal, everything maps to 0.
 */
export function minMaxNormalize(
  scores: Map<string, number>
): Map<string, number> {
  if (scores.size === 0) return scores;
  const values = Array.from(scores.values());
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range === 0) {
    return new Map(Array.from(scores.keys()).map((k) => [k, 0]));
  }
  return new Map(
    Array.from(scores.entries()).map(([k, v]) => [k, (v - min) / range])
  );
}

/**
 * Blend vector similarity and normalized BM25 into a single hybrid score.
 */
export function hybridScore(vecSim: number, bm25Norm: number): number {
  return VEC_WEIGHT * vecSim + BM25_WEIGHT * bm25Norm;
}
