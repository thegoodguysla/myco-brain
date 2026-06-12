/**
 * Full dynamic schema — gated auto-promotion of schema proposals.
 *
 * Phase 1 (schema-proposals.ts) lets the extraction worker PROPOSE new entity
 * kinds and relationship types it observes. This module completes the loop:
 * proposals that earn enough independent corroboration auto-promote into the
 * live catalogs (entity_kinds / relation_types), so the schema evolves with
 * your data — under explicit operator opt-in.
 *
 * Promotion rules (all must hold):
 *   - BRAIN_SCHEMA_AUTO_PROMOTE=1            (default OFF — proposals stay
 *                                             pending for manual review)
 *   - NOT strict curation mode               (BRAIN_REQUIRE_HUMAN_REVIEW=1
 *                                             always wins)
 *   - seen_count   >= BRAIN_SCHEMA_PROMOTE_MIN_SEEN        (default 3 —
 *     sightings from distinct documents; one chatty document never promotes)
 *   - confidence   >= BRAIN_SCHEMA_PROMOTE_MIN_CONFIDENCE  (default 0.8)
 *
 * Audit trail: the schema_proposals row records the whole story — who
 * proposed it (extracted_by), the evidence (seen_count, confidence,
 * source_hyobject_id), and the outcome (state='auto_promoted', applied_id,
 * reviewed_at). Nothing is deleted; demotion is a manual catalog edit.
 */
import type pg from "pg";

export interface SchemaPromotionOptions {
  enabled: boolean;
  strictMode: boolean;
  minSeen: number;
  minConfidence: number;
}

export function schemaPromotionOptions(): SchemaPromotionOptions {
  const num = (raw: string | undefined, dflt: number, lo: number, hi: number) => {
    const n = raw != null ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
  };
  return {
    enabled: process.env.BRAIN_SCHEMA_AUTO_PROMOTE === "1",
    strictMode: process.env.BRAIN_REQUIRE_HUMAN_REVIEW === "1",
    minSeen: num(process.env.BRAIN_SCHEMA_PROMOTE_MIN_SEEN, 3, 1, 1000),
    minConfidence: num(process.env.BRAIN_SCHEMA_PROMOTE_MIN_CONFIDENCE, 0.8, 0, 1),
  };
}

/** Pure: does a proposal meet the promotion bar? (Gating tested in unit tests.) */
export function eligibleForPromotion(
  proposal: { seen_count: number; confidence: number; state: string },
  opts: SchemaPromotionOptions
): boolean {
  return (
    opts.enabled &&
    !opts.strictMode &&
    proposal.state === "pending" &&
    proposal.seen_count >= opts.minSeen &&
    proposal.confidence >= opts.minConfidence
  );
}

export interface PromotedType {
  proposal_type: string;
  name: string;
  applied_id: number;
}

/**
 * Promote every eligible pending proposal in the workspace. Returns what was
 * promoted. Caller should refresh its catalog caches when non-empty.
 */
export async function autoPromoteSchemaProposals(
  client: pg.PoolClient,
  workspaceId: string,
  opts: SchemaPromotionOptions = schemaPromotionOptions()
): Promise<PromotedType[]> {
  if (!opts.enabled || opts.strictMode) return [];

  const pending = await client.query<{
    id: string;
    proposal_type: string;
    name: string;
    seen_count: number;
    confidence: string;
  }>(
    `SELECT id, proposal_type, name, seen_count, confidence
       FROM schema_proposals
      WHERE workspace_id = $1
        AND state = 'pending'
        AND proposal_type IN ('entity_kind', 'relation_type')
        AND seen_count >= $2
        AND confidence >= $3
      ORDER BY seen_count DESC, confidence DESC
      FOR UPDATE SKIP LOCKED`,
    [workspaceId, opts.minSeen, opts.minConfidence]
  );

  const promoted: PromotedType[] = [];
  for (const p of pending.rows) {
    // Id-safe catalog insert: skip if a same-named (normalization-tolerant)
    // catalog row already exists, otherwise allocate past the current max.
    const table = p.proposal_type === "entity_kind" ? "entity_kinds" : "relation_types";
    const idCol = p.proposal_type === "entity_kind" ? "kind_id" : "relation_type_id";
    const existing = await client.query<{ id: number }>(
      `SELECT ${idCol} AS id FROM ${table}
        WHERE lower(regexp_replace(name, '[_-]+', ' ', 'g')) = $1 LIMIT 1`,
      [p.name]
    );
    let appliedId = existing.rows[0]?.id;
    if (appliedId === undefined) {
      const ins = await client.query<{ id: number }>(
        `INSERT INTO ${table} (${idCol}, name)
         VALUES ((SELECT coalesce(max(${idCol}), 0) + 1 FROM ${table}), $1)
         RETURNING ${idCol} AS id`,
        [p.name]
      );
      appliedId = ins.rows[0].id;
    }

    await client.query(
      `UPDATE schema_proposals
          SET state = 'auto_promoted', applied_id = $2, reviewed_at = now()
        WHERE id = $1`,
      [p.id, appliedId]
    );
    promoted.push({ proposal_type: p.proposal_type, name: p.name, applied_id: appliedId });
  }
  return promoted;
}
