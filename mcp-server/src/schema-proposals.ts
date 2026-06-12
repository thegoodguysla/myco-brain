/**
 * Dynamic schema — phase 1: propose-and-surface.
 *
 * When the extraction worker sees an entity KIND that isn't in the
 * entity_kinds catalog, or a relation PREDICATE that isn't in the
 * relation_types catalog, it records a row in schema_proposals
 * (state='pending'). Nothing is auto-promoted — a human (or a later phase)
 * reviews proposals; brain_stats surfaces "Brain proposed N new types from
 * your data" so the loop is visible.
 *
 * collectSchemaProposals() is pure (unit-tested in CI);
 * persistSchemaProposals() writes with ON CONFLICT DO NOTHING against the
 * UNIQUE (workspace_id, proposal_type, name) constraint, so repeated
 * observations of the same type never duplicate.
 */
import type pg from "pg";
import type { ExtractionOutput } from "./extraction-worker.lib.js";

export type SchemaProposalType = "entity_kind" | "relation_type";

export interface SchemaProposalCandidate {
  proposal_type: SchemaProposalType;
  name: string;
  confidence: number;
}

// Only propose names that look like real type names — short, lowercase,
// word-ish. Keeps LLM junk ("the company mentioned above") out of the queue.
const NAME_RE = /^[a-z][a-z0-9]*(?: [a-z0-9]+){0,3}$/;
const MAX_NAME_LENGTH = 40;

// Predicates the extraction prompt itself mandates as examples (extraction.ts).
// These are never "novel" — without this, a fresh install (whose relation_types
// catalog ships empty) would flag the prompt's own vocabulary as proposed new
// types on the very first ingest, making the brain_stats signal pure noise.
export const CANONICAL_PREDICATES: ReadonlySet<string> = new Set([
  "acquired",
  "founded",
  "works for",
  "reports to",
  "manages",
  "owns",
  "hired",
  "located in",
]);

/** Minimum confidence for a proposal (env-overridable; default 0.6, inclusive). */
export function schemaProposalMinConfidence(): number {
  const raw = process.env.BRAIN_SCHEMA_PROPOSAL_MIN_CONFIDENCE;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.6;
}

/**
 * Normalize a type name for comparison and storage: lowercase, with
 * underscore/hyphen separators folded to single spaces — so a catalog entry
 * like "ASSIGNED_TO" and an extracted "assigned to" compare equal. Returns
 * null for anything that doesn't look like a real type name.
 */
export function normalizeTypeName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const v = name
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!v || v.length > MAX_NAME_LENGTH || !NAME_RE.test(v)) return null;
  return v;
}

/**
 * Pure: decide which schema proposals an extraction output justifies.
 * Catalog sets must be lowercase. Dedupes by (type, name), keeping the
 * highest confidence seen.
 */
export function collectSchemaProposals(
  output: ExtractionOutput,
  knownKinds: Set<string>,
  knownPredicates: Set<string>,
  minConfidence: number = schemaProposalMinConfidence()
): SchemaProposalCandidate[] {
  const best = new Map<string, SchemaProposalCandidate>();

  const consider = (
    proposal_type: SchemaProposalType,
    rawName: unknown,
    confidence: number,
    known: Set<string>
  ) => {
    if (confidence < minConfidence) return;
    const name = normalizeTypeName(rawName);
    if (!name || known.has(name)) return;
    if (proposal_type === "relation_type" && CANONICAL_PREDICATES.has(name)) return;
    const key = `${proposal_type}:${name}`;
    const existing = best.get(key);
    if (!existing || confidence > existing.confidence) {
      best.set(key, { proposal_type, name, confidence });
    }
  };

  for (const entity of output.entities) {
    consider("entity_kind", entity.kind, entity.confidence, knownKinds);
  }
  for (const rel of output.relations ?? []) {
    consider("relation_type", rel.predicate, rel.confidence, knownPredicates);
  }

  return [...best.values()];
}

/**
 * Insert proposals as pending rows; repeat sightings COMPOUND instead of
 * no-oping. A sighting from a different document than the last one recorded
 * increments seen_count (the corroboration signal auto-promotion reads — see
 * schema-promotion.ts) and keeps the max confidence; repeat sightings from
 * the same document only refresh last_seen_at. Returns how many proposals
 * were newly created.
 */
export async function persistSchemaProposals(
  client: pg.PoolClient,
  workspaceId: string,
  sourceHyobjectId: string | null,
  extractedBy: string,
  candidates: SchemaProposalCandidate[]
): Promise<number> {
  let created = 0;
  for (const c of candidates) {
    const res = await client.query<{ inserted: boolean }>(
      `INSERT INTO schema_proposals
         (workspace_id, proposal_type, name, description, source_hyobject_id,
          extracted_by, confidence, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       ON CONFLICT (workspace_id, proposal_type, name) DO UPDATE SET
         seen_count = schema_proposals.seen_count
           + CASE WHEN schema_proposals.source_hyobject_id IS DISTINCT FROM EXCLUDED.source_hyobject_id
                  THEN 1 ELSE 0 END,
         confidence = GREATEST(schema_proposals.confidence, EXCLUDED.confidence),
         source_hyobject_id = COALESCE(EXCLUDED.source_hyobject_id, schema_proposals.source_hyobject_id),
         last_seen_at = now()
       WHERE schema_proposals.state = 'pending'
       RETURNING (xmax = 0) AS inserted`,
      [
        workspaceId,
        c.proposal_type,
        c.name,
        c.proposal_type === "entity_kind"
          ? `Entity kind observed in your data but not in the catalog (proposed by the extraction worker).`
          : `Relationship type observed in your data but not in the catalog (proposed by the extraction worker).`,
        sourceHyobjectId,
        extractedBy,
        c.confidence,
      ]
    );
    if (res.rows[0]?.inserted) created++;
  }
  return created;
}
