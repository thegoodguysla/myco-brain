/**
 * Compounding confidence — the contradiction half.
 *
 * Corroboration makes confidence RISE (confidence.ts); contradiction makes it
 * FALL and supersedes the old fact instead of overwriting it. Phase B detects
 * the deterministic case: FUNCTIONAL predicates — relationships where a
 * subject has exactly one current object ("works for", "reports to",
 * "located in"). When a confident new edge (s, p, o2) arrives while an active
 * edge (s, p, o1≠o2) exists, the old edge is:
 *
 *   1. closed, not deleted — `valid_to = now()` (it stays queryable as
 *      history; the vc audit trigger records the change), and
 *   2. weakened — its confidence falls by the damped contradiction penalty
 *      (same α as corroboration, so one contradiction roughly cancels one
 *      corroboration), and
 *   3. superseded in the claims ledger — a new claims row records the new
 *      fact, and the old claim points at it via `superseded_by` with
 *      `valid_to` closed. Never silently overwritten.
 *
 * Re-assertion later creates a fresh edge (find-or-create only matches ACTIVE
 * edges), which inherits the triple's historical evidence on rescore — sources
 * that asserted a fact still count for it if it comes back.
 */
import type pg from "pg";
import { DEFAULT_ALPHA } from "./confidence.js";
import { normalizeTypeName } from "./schema-proposals.js";

/** Predicates where a subject has one current object. */
export const DEFAULT_FUNCTIONAL_PREDICATES: ReadonlySet<string> = new Set([
  "works for",
  "reports to",
  "located in",
]);

/**
 * The functional-predicate set, with optional env extension
 * (BRAIN_FUNCTIONAL_PREDICATES, comma-separated; names normalized the same
 * way catalog predicates are, so "REPORTS_TO" works).
 */
export function functionalPredicates(): Set<string> {
  const set = new Set(DEFAULT_FUNCTIONAL_PREDICATES);
  const raw = process.env.BRAIN_FUNCTIONAL_PREDICATES;
  if (raw) {
    for (const part of raw.split(",")) {
      const n = normalizeTypeName(part);
      if (n) set.add(n);
    }
  }
  return set;
}

/**
 * Pure: the contradicted fact's new (fallen) confidence. Damped by the same
 * α as corroboration: conf' = conf * (1 - α·c_contradicting), floored at 0.
 */
export function contradictionPenalty(
  oldConfidence: number,
  contradictingConfidence: number,
  alpha: number = DEFAULT_ALPHA
): number {
  const clamp01 = (n: number): number =>
    Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  const c = clamp01(contradictingConfidence);
  const o = clamp01(oldConfidence);
  return Math.max(0, o * (1 - alpha * c));
}

export interface SupersedeResult {
  /** Edges closed + weakened by this contradiction. */
  superseded: number;
  /** The claims-ledger row recording the new fact (null if no contradiction). */
  new_claim_id: string | null;
}

/**
 * Detect and supersede active edges contradicted by a confident new
 * observation (s, predicate, newObject) on a functional predicate. No-op for
 * non-functional predicates. Call after the new edge is persisted.
 */
export async function supersedeContradictedRelations(
  client: pg.PoolClient,
  workspaceId: string,
  subjectId: string,
  predicate: string,
  newObjectId: string,
  newConfidence: number,
  sourceHyobjectId: string | null,
  extractedBy: string
): Promise<SupersedeResult> {
  const normalized = normalizeTypeName(predicate);
  if (!normalized || !functionalPredicates().has(normalized)) {
    return { superseded: 0, new_claim_id: null };
  }

  // Active edges asserting a DIFFERENT current object for the same subject
  // and predicate — the deterministic contradiction.
  const conflicts = await client.query<{
    id: string;
    entity2_id: string;
    confidence: string;
    source_hyobject_id: string | null;
    valid_from: string;
  }>(
    `SELECT id, entity2_id, confidence, source_hyobject_id, valid_from
       FROM entity_relations
      WHERE workspace_id = $1
        AND entity1_id = $2
        AND predicate = $3
        AND entity2_id <> $4
        AND (valid_to IS NULL OR valid_to > now())`,
    [workspaceId, subjectId, predicate, newObjectId]
  );
  if (conflicts.rows.length === 0) return { superseded: 0, new_claim_id: null };

  // The claims ledger records the new fact once per contradiction event.
  const newClaim = await client.query<{ claim_id: string }>(
    `INSERT INTO claims
       (workspace_id, subject_kind, subject_id, attribute, value,
        source_hyobject_id, extracted_by, confidence, state, valid_from)
     VALUES ($1, 'entity', $2, $3, $4, $5, $6, $7, 'auto_promoted', now())
     RETURNING claim_id`,
    [
      workspaceId,
      subjectId,
      predicate,
      JSON.stringify({ entity_id: newObjectId }),
      sourceHyobjectId,
      extractedBy,
      Math.max(0, Math.min(1, newConfidence)),
    ]
  );
  const newClaimId = newClaim.rows[0].claim_id;

  let superseded = 0;
  for (const old of conflicts.rows) {
    const fallen = contradictionPenalty(Number(old.confidence), newConfidence);

    // 1+2. Close and weaken the contradicted edge (vc trigger audits both).
    await client.query(
      `UPDATE entity_relations
          SET valid_to = now(), confidence = $2
        WHERE id = $1`,
      [old.id, fallen]
    );

    // 3. Claims chain: find (or backfill) the old fact's claim, then mark it
    //    superseded by the new one — visible, never overwritten.
    const oldClaim = await client.query<{ claim_id: string }>(
      `SELECT claim_id FROM claims
        WHERE workspace_id = $1 AND subject_kind = 'entity' AND subject_id = $2
          AND attribute = $3 AND value->>'entity_id' = $4
          AND superseded_by IS NULL
        ORDER BY recorded_at DESC LIMIT 1`,
      [workspaceId, subjectId, predicate, old.entity2_id]
    );
    let oldClaimId = oldClaim.rows[0]?.claim_id;
    if (!oldClaimId) {
      const backfill = await client.query<{ claim_id: string }>(
        `INSERT INTO claims
           (workspace_id, subject_kind, subject_id, attribute, value,
            source_hyobject_id, extracted_by, confidence, state, valid_from)
         VALUES ($1, 'entity', $2, $3, $4, $5, $6, $7, 'auto_promoted', $8)
         RETURNING claim_id`,
        [
          workspaceId,
          subjectId,
          predicate,
          JSON.stringify({ entity_id: old.entity2_id }),
          old.source_hyobject_id,
          extractedBy,
          Number(old.confidence),
          old.valid_from,
        ]
      );
      oldClaimId = backfill.rows[0].claim_id;
    }
    await client.query(
      `UPDATE claims SET superseded_by = $2, valid_to = now() WHERE claim_id = $1`,
      [oldClaimId, newClaimId]
    );
    superseded++;
  }

  return { superseded, new_claim_id: newClaimId };
}
