/**
 * Compounding confidence — the scoring engine.
 *
 * A fact seen in several INDEPENDENT sources deserves more confidence than a
 * fact seen once; a fact's confidence should never be silently overwritten by
 * whichever extraction happened to run last. This module turns the evidence
 * rows in relation_evidence into a single compounded confidence per edge.
 *
 * Formula (damped noisy-OR, anchored on the strongest source):
 *
 *   combined = 1 - (1 - c_max) * Π over other sources (1 - α·c_i)
 *
 *   - c_max     the strongest single source's confidence. With exactly one
 *               source the result IS c_max — existing single-source edges keep
 *               the confidence extraction gave them (no behavior change).
 *   - α (0.4)   per-source damping: two LLM extractions are never fully
 *               independent (same model biases, same domain), so a
 *               corroborating source only claims a fraction of the remaining
 *               uncertainty.
 *   - cap (0.95) corroboration alone never reaches certainty — room is left
 *               for contradiction to matter. The cap never pulls a value
 *               BELOW the strongest observed source.
 *
 * The product form is order-independent: it doesn't matter which source was
 * ingested first. "Independent" means a distinct source document
 * (evidence_hyobject_id) — ten chunks of the same document corroborate
 * nothing.
 */
import type pg from "pg";

export interface CombineOptions {
  /** Per-source damping for non-anchor sources. */
  alpha?: number;
  /** Ceiling for corroboration (never applied below the strongest source). */
  cap?: number;
}

export const DEFAULT_ALPHA = 0.4;
export const DEFAULT_CAP = 0.95;

const clamp01 = (n: number): number =>
  Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;

/**
 * Combine per-source confidences (one entry per independent source) into a
 * compounded confidence. Empty input → 0.
 */
export function combineIndependentEvidence(
  confidences: number[],
  opts: CombineOptions = {}
): number {
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const cap = opts.cap ?? DEFAULT_CAP;

  const cs = confidences.map(clamp01).filter((c) => c > 0);
  if (cs.length === 0) return 0;

  const max = Math.max(...cs);
  let remaining = 1 - max;
  let anchorUsed = false;
  for (const c of cs) {
    if (!anchorUsed && c === max) {
      // The strongest source is the anchor and contributes fully (skip it
      // here); equal-confidence duplicates still damp via the else branch.
      anchorUsed = true;
      continue;
    }
    remaining *= 1 - alpha * c;
  }
  const combined = 1 - remaining;

  // Cap corroboration short of certainty, but never below the best source.
  return Math.min(Math.max(cap, max), combined);
}

/**
 * Collapse raw evidence rows to one confidence per independent source: max
 * confidence per source id. Rows with no source id (unknown provenance) are
 * conservatively collapsed into a single bucket, so untraceable evidence can
 * never compound itself.
 */
export function dedupeBySource(
  rows: Array<{ sourceId: string | null; confidence: number }>
): number[] {
  const best = new Map<string, number>();
  for (const row of rows) {
    const key = row.sourceId ?? "(unknown)";
    const c = clamp01(row.confidence);
    const prev = best.get(key);
    if (prev === undefined || c > prev) best.set(key, c);
  }
  return [...best.values()];
}

export interface RescoreResult {
  /** Independent source documents backing the edge. */
  sources: number;
  /** The compounded confidence written to the edge (null if no evidence). */
  confidence: number | null;
}

/**
 * Recompute an entity_relations edge's confidence from all of its
 * relation_evidence rows (deduped per source document) and persist it.
 * Call after recording a new sighting. No-op when no evidence rows exist.
 */
export async function rescoreEntityRelation(
  client: pg.PoolClient,
  workspaceId: string,
  entity1Id: string,
  entity2Id: string,
  predicate: string
): Promise<RescoreResult> {
  const res = await client.query<{
    evidence_hyobject_id: string | null;
    confidence: string;
  }>(
    `SELECT evidence_hyobject_id, confidence
       FROM relation_evidence
      WHERE workspace_id = $1
        AND relation_kind = 'entity_relation'
        AND source_node_id = $2
        AND target_node_id = $3
        AND predicate = $4`,
    [workspaceId, entity1Id, entity2Id, predicate]
  );
  if (res.rows.length === 0) return { sources: 0, confidence: null };

  const perSource = dedupeBySource(
    res.rows.map((r) => ({
      sourceId: r.evidence_hyobject_id,
      confidence: Number(r.confidence),
    }))
  );
  const combined = combineIndependentEvidence(perSource);

  await client.query(
    `UPDATE entity_relations
        SET confidence = $5
      WHERE workspace_id = $1
        AND entity1_id = $2
        AND entity2_id = $3
        AND predicate = $4
        AND (valid_to IS NULL OR valid_to > now())`,
    [workspaceId, entity1Id, entity2Id, predicate, combined]
  );

  return { sources: perSource.length, confidence: combined };
}
