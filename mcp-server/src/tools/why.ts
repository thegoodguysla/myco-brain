/**
 * brain_why — provenance chain inspection.
 *
 * Given a hyobject_id (document, entity, or fact), traces its provenance:
 *   - Source storage URI and ingestion metadata
 *   - VC (audit trail) entries showing who created/modified it and why
 *   - Relations that led to this record being created
 *   - Proposals that were promoted to create it
 */
import { z } from "zod";
import { withSession, type SessionContext } from "../db.js";
import { hyobjectVisibleSql } from "../sharing.js";

export const WhyInput = z.object({
  hyobject_id: z
    .string()
    .uuid()
    .optional()
    .describe("Trace provenance of a hyobject"),
  entity_id: z
    .string()
    .uuid()
    .optional()
    .describe("Trace provenance of an entity"),
  people_id: z
    .string()
    .uuid()
    .optional()
    .describe("Trace provenance of a person record"),
  entity_a_id: z
    .string()
    .uuid()
    .optional()
    .describe("First entity ID for pairwise provenance"),
  entity_b_id: z
    .string()
    .uuid()
    .optional()
    .describe("Second entity ID for pairwise provenance"),
  limit_vc: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Max VC audit entries to return"),
}).refine((d) => {
  const hasSingle = Boolean(d.hyobject_id || d.entity_id || d.people_id);
  const hasPairA = Boolean(d.entity_a_id);
  const hasPairB = Boolean(d.entity_b_id);
  const hasPair = hasPairA || hasPairB;
  if (hasPairA !== hasPairB) return false;
  if (hasSingle && hasPair) return false;
  return hasSingle || hasPair;
}, {
  message:
    "Provide exactly one mode: hyobject_id/entity_id/people_id OR both entity_a_id and entity_b_id",
});

export type WhyInput = z.infer<typeof WhyInput>;

export interface WhyResult {
  subject: SubjectInfo | null;
  vc_trail: VcEntry[];
  source_proposals: ProposalEntry[];
  ingest_info: IngestInfo | null;
  evidence?: EvidenceSummary | null;
  pairwise_provenance?: PairwiseProvenance;
}

// How much independent evidence backs this fact. As more documents mention an
// entity, its evidence grows — the visible, queryable form of compounding
// memory: a fact you've seen in five sources is better-supported than one seen
// in one.
interface EvidenceSummary {
  mention_count: number;
  source_document_count: number;
  summary: string;
}

interface SubjectInfo {
  kind: "hyobject" | "entity" | "person";
  id: string;
  name: string | null;
  created_at: string;
  processing_state?: string;
  storage_uri?: string | null;
}

interface VcEntry {
  vc_id: number;
  column_name: string;
  operation: string;
  actor_kind: string;
  actor_id: string;
  reason: string | null;
  old_value: unknown;
  new_value: unknown;
  changed_at: string;
}

interface ProposalEntry {
  id: string;
  kind: "entity" | "relation";
  extracted_by: string;
  confidence: number;
  state: string;
  source_hyobject_id: string | null;
  created_at: string;
}

interface IngestInfo {
  sha256: string | null;
  mime_type: string | null;
  byte_size: number | null;
  page_count: number | null;
  language: string | null;
  author_from_metadata: string | null;
  created_from_source_at: string | null;
}

interface PairwiseEntity {
  id: string;
  name: string | null;
  created_at: string;
}

interface PairwiseDirectRelation {
  id: string;
  predicate: string;
  confidence: number | null;
  source_hyobject_id: string | null;
  created_at: string;
  vc_trail: VcEntry[];
  // Compounding confidence: how many distinct source documents back this
  // edge, and how its confidence moved as evidence accumulated (derived from
  // the vc audit trail — deterministic history, e.g. "0.8 → 0.86 → 0.93").
  independent_sources: number;
  confidence_trend: string | null;
}

// A contradicted edge: closed (valid_to set) and weakened, never deleted —
// the contradiction stays visible instead of being silently overwritten.
interface PairwiseSupersededRelation {
  id: string;
  predicate: string;
  confidence: number | null;
  valid_from: string;
  valid_to: string;
}

interface PairwiseSharedDocument {
  hyobject_id: string;
  hyobject_name: string | null;
  a_mentions: number;
  b_mentions: number;
  mention_row_ids: string[];
  vc_trail: VcEntry[];
}

interface PairwiseProvenance {
  entity_a: PairwiseEntity;
  entity_b: PairwiseEntity;
  direct_relations: PairwiseDirectRelation[];
  superseded_relations: PairwiseSupersededRelation[];
  shared_documents: PairwiseSharedDocument[];
}

export async function why(
  ctx: SessionContext,
  input: WhyInput
): Promise<WhyResult> {
  return withSession(ctx, async (client) => {
    if (input.entity_a_id && input.entity_b_id) {
      const entitiesRes = await client.query(
        `SELECT entity_id, canonical_name, created_at
         FROM entities
         WHERE entity_id = ANY($1::uuid[])`,
        [[input.entity_a_id, input.entity_b_id]]
      );

      if (entitiesRes.rows.length !== 2) {
        throw new Error("pairwise entities not found");
      }

      const byId = new Map<string, { entity_id: string; canonical_name: string | null; created_at: string }>();
      for (const row of entitiesRes.rows) {
        byId.set(row.entity_id, row);
      }

      const rowA = byId.get(input.entity_a_id);
      const rowB = byId.get(input.entity_b_id);
      if (!rowA || !rowB) {
        throw new Error("pairwise entities not found");
      }

      const directRes = await client.query(
        `SELECT id, predicate, confidence, source_hyobject_id, created_at
         FROM entity_relations
         WHERE (
             (entity1_id = $1 AND entity2_id = $2)
             OR
             (entity1_id = $2 AND entity2_id = $1)
           )
           AND valid_to IS NULL
         ORDER BY confidence DESC NULLS LAST, created_at DESC
         LIMIT $3`,
        [input.entity_a_id, input.entity_b_id, input.limit_vc]
      );

      const directRelations: PairwiseDirectRelation[] = [];
      for (const row of directRes.rows) {
        const vcTrail = await loadVcTrail(client, "entity_relations", row.id, input.limit_vc);

        // Compounding confidence: distinct backing documents + the audited
        // confidence history for this edge.
        const evRes = await client.query<{ n: number }>(
          `SELECT COUNT(DISTINCT evidence_hyobject_id)::int AS n
             FROM relation_evidence
            WHERE relation_kind = 'entity_relation' AND relation_row_id = $1
              AND evidence_hyobject_id IS NOT NULL`,
          [row.id]
        );
        const trendRes = await client.query<{ v: string }>(
          `SELECT new_value #>> '{}' AS v
             FROM vc
            WHERE table_name = 'entity_relations' AND row_id = $1
              AND column_name = 'confidence' AND new_value IS NOT NULL
            ORDER BY changed_at ASC, vc_id ASC`,
          [row.id]
        );
        const trendValues = trendRes.rows
          .map((r) => Number(r.v))
          .filter((n) => Number.isFinite(n))
          .map((n) => String(Math.round(n * 1000) / 1000));

        directRelations.push({
          id: row.id,
          predicate: row.predicate,
          confidence: row.confidence == null ? null : Number(row.confidence),
          source_hyobject_id: row.source_hyobject_id ?? null,
          created_at: row.created_at,
          vc_trail: vcTrail,
          independent_sources: Number(evRes.rows[0]?.n ?? 0),
          confidence_trend:
            trendValues.length >= 2 ? trendValues.join(" → ") : null,
        });
      }

      // Contradicted (superseded) edges between the pair — visible history.
      const supersededRes = await client.query(
        `SELECT id, predicate, confidence, valid_from, valid_to
           FROM entity_relations
          WHERE (
              (entity1_id = $1 AND entity2_id = $2)
              OR
              (entity1_id = $2 AND entity2_id = $1)
            )
            AND valid_to IS NOT NULL AND valid_to <= now()
          ORDER BY valid_to DESC
          LIMIT $3`,
        [input.entity_a_id, input.entity_b_id, input.limit_vc]
      );
      const supersededRelations: PairwiseSupersededRelation[] =
        supersededRes.rows.map((r) => ({
          id: r.id,
          predicate: r.predicate,
          confidence: r.confidence == null ? null : Number(r.confidence),
          valid_from: r.valid_from,
          valid_to: r.valid_to,
        }));

      const sharedRes = await client.query(
        `SELECT
           em.hyobject_id,
           h.name AS hyobject_name,
           COUNT(*) FILTER (WHERE em.entity_id = $1)::int AS a_mentions,
           COUNT(*) FILTER (WHERE em.entity_id = $2)::int AS b_mentions,
           ARRAY_AGG(em.id::text) AS mention_row_ids
         FROM entity_mentions em
         JOIN hyobjects h ON h.hyobject_id = em.hyobject_id AND ${hyobjectVisibleSql("h")}
         WHERE em.entity_id IN ($1, $2)
         GROUP BY em.hyobject_id, h.name, h.created_at
         HAVING COUNT(DISTINCT em.entity_id) = 2
         ORDER BY
           (COUNT(*) FILTER (WHERE em.entity_id = $1)
           + COUNT(*) FILTER (WHERE em.entity_id = $2)) DESC,
           h.created_at DESC
         LIMIT $3`,
        [input.entity_a_id, input.entity_b_id, input.limit_vc]
      );

      const sharedDocuments: PairwiseSharedDocument[] = [];
      for (const row of sharedRes.rows) {
        const mentionRowIds = Array.isArray(row.mention_row_ids) ? (row.mention_row_ids as string[]) : [];
        const vcTrail = mentionRowIds.length
          ? await loadVcTrailForRows(client, "entity_mentions", mentionRowIds, input.limit_vc)
          : [];
        sharedDocuments.push({
          hyobject_id: row.hyobject_id,
          hyobject_name: row.hyobject_name ?? null,
          a_mentions: Number(row.a_mentions),
          b_mentions: Number(row.b_mentions),
          mention_row_ids: mentionRowIds,
          vc_trail: vcTrail,
        });
      }

      return {
        subject: null,
        vc_trail: [],
        source_proposals: [],
        ingest_info: null,
        pairwise_provenance: {
          entity_a: {
            id: rowA.entity_id,
            name: rowA.canonical_name,
            created_at: rowA.created_at,
          },
          entity_b: {
            id: rowB.entity_id,
            name: rowB.canonical_name,
            created_at: rowB.created_at,
          },
          direct_relations: directRelations,
          superseded_relations: supersededRelations,
          shared_documents: sharedDocuments,
        },
      };
    }

    let subject: SubjectInfo;
    let tableName: string;
    let rowId: string;

    if (input.hyobject_id) {
      const res = await client.query(
        `SELECT hyobject_id, name, created_at, processing_state, storage_uri,
                sha256, mime_type, byte_size, page_count, language,
                author_from_metadata, created_from_source_at
         FROM hyobjects WHERE hyobject_id = $1 AND ${hyobjectVisibleSql("hyobjects")}`,
        [input.hyobject_id]
      );
      if (res.rows.length === 0) throw new Error("hyobject not found");
      const row = res.rows[0];
      subject = {
        kind: "hyobject",
        id: row.hyobject_id,
        name: row.name,
        created_at: row.created_at,
        processing_state: row.processing_state,
        storage_uri: row.storage_uri,
      };
      tableName = "hyobjects";
      rowId = input.hyobject_id;
    } else if (input.entity_id) {
      const res = await client.query(
        `SELECT entity_id, canonical_name, created_at FROM entities WHERE entity_id = $1`,
        [input.entity_id]
      );
      if (res.rows.length === 0) throw new Error("entity not found");
      const row = res.rows[0];
      subject = {
        kind: "entity",
        id: row.entity_id,
        name: row.canonical_name,
        created_at: row.created_at,
      };
      tableName = "entities";
      rowId = input.entity_id;
    } else {
      const res = await client.query(
        `SELECT people_id, display_name, created_at FROM people WHERE people_id = $1`,
        [input.people_id]
      );
      if (res.rows.length === 0) throw new Error("person not found");
      const row = res.rows[0];
      subject = {
        kind: "person",
        id: row.people_id,
        name: row.display_name,
        created_at: row.created_at,
      };
      tableName = "people";
      rowId = input.people_id!;
    }

    // VC trail
    const vcRes = await client.query(
      `SELECT vc_id, column_name, operation, actor_kind, actor_id, reason,
              old_value, new_value, changed_at
       FROM vc
       WHERE table_name = $1 AND row_id = $2
       ORDER BY changed_at ASC
       LIMIT $3`,
      [tableName, rowId, input.limit_vc]
    );

    // Source proposals (only for hyobjects and entities)
    let proposals: ProposalEntry[] = [];
    if (input.hyobject_id) {
      const propRes = await client.query(
        `SELECT id, 'entity' AS kind, extracted_by, confidence, state,
                source_hyobject_id, created_at
         FROM proposed_entities
         WHERE promoted_entity_id IS NOT NULL
           AND source_hyobject_id = $1
         UNION ALL
         SELECT id, 'relation' AS kind, extracted_by, confidence, state,
                source_hyobject_id, created_at
         FROM proposed_relations
         WHERE source_hyobject_id = $1
         ORDER BY created_at ASC`,
        [input.hyobject_id]
      );
      proposals = propRes.rows as ProposalEntry[];
    } else if (input.entity_id) {
      const propRes = await client.query(
        `SELECT id, 'entity' AS kind, extracted_by, confidence, state,
                source_hyobject_id, created_at
         FROM proposed_entities
         WHERE promoted_entity_id = $1`,
        [input.entity_id]
      );
      proposals = propRes.rows as ProposalEntry[];
    }

    // Ingest info for hyobjects
    let ingestInfo: IngestInfo | null = null;
    if (input.hyobject_id) {
      const row = await client.query(
        `SELECT sha256, mime_type, byte_size, page_count, language,
                author_from_metadata, created_from_source_at
         FROM hyobjects WHERE hyobject_id = $1 AND ${hyobjectVisibleSql("hyobjects")}`,
        [input.hyobject_id]
      );
      if (row.rows[0]) {
        const r = row.rows[0];
        ingestInfo = {
          sha256: r.sha256,
          mime_type: r.mime_type,
          byte_size: r.byte_size,
          page_count: r.page_count,
          language: r.language,
          author_from_metadata: r.author_from_metadata,
          created_from_source_at: r.created_from_source_at,
        };
      }
    }

    // Evidence summary for entities: how many mentions across how many distinct
    // source documents support this entity. More sources = stronger support.
    let evidence: EvidenceSummary | null = null;
    if (input.entity_id) {
      const ev = await client.query<{ mentions: string; sources: string }>(
        `SELECT COUNT(*)::text AS mentions,
                COUNT(DISTINCT hyobject_id)::text AS sources
           FROM entity_mentions
          WHERE entity_id = $1`,
        [input.entity_id]
      );
      const mention_count = Number(ev.rows[0]?.mentions ?? 0);
      const source_document_count = Number(ev.rows[0]?.sources ?? 0);
      evidence = {
        mention_count,
        source_document_count,
        summary:
          source_document_count === 0
            ? "No source mentions yet."
            : `Supported by ${mention_count} mention${mention_count === 1 ? "" : "s"} across ${source_document_count} source document${source_document_count === 1 ? "" : "s"}.`,
      };
    }

    return {
      subject,
      vc_trail: vcRes.rows as VcEntry[],
      source_proposals: proposals,
      ingest_info: ingestInfo,
      evidence,
    };
  });
}

async function loadVcTrail(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: VcEntry[] }> },
  tableName: string,
  rowId: string,
  limit: number
): Promise<VcEntry[]> {
  const vcRes = await client.query(
    `SELECT vc_id, column_name, operation, actor_kind, actor_id, reason,
            old_value, new_value, changed_at
     FROM vc
     WHERE table_name = $1 AND row_id = $2
     ORDER BY changed_at ASC
     LIMIT $3`,
    [tableName, rowId, limit]
  );
  return vcRes.rows;
}

async function loadVcTrailForRows(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: VcEntry[] }> },
  tableName: string,
  rowIds: string[],
  limit: number
): Promise<VcEntry[]> {
  const vcRes = await client.query(
    `SELECT vc_id, column_name, operation, actor_kind, actor_id, reason,
            old_value, new_value, changed_at
     FROM vc
     WHERE table_name = $1 AND row_id = ANY($2::uuid[])
     ORDER BY changed_at ASC
     LIMIT $3`,
    [tableName, rowIds, limit]
  );
  return vcRes.rows;
}
