/**
 * brain_get_related — relational context query with provenance.
 *
 * Returns direct relations for a subject node (hyobject/entity/person), including:
 *   - Relation edge metadata
 *   - Target node summary
 *   - Provenance pointers (source_hyobject + VC audit entries for the edge row)
 */
import { z } from "zod";
import type { PoolClient } from "pg";
import { withSession, type SessionContext } from "../db.js";
import { hyobjectVisibleSql } from "../sharing.js";

export const GetRelatedInput = z.object({
  subject_id: z.string().uuid(),
  subject_kind: z.enum(["hyobject", "entity", "person"]),
  target_kinds: z
    .array(z.enum(["hyobject", "entity", "person"]))
    .optional()
    .describe("Optional target kind filter"),
  relation_type_ids: z
    .array(z.number().int())
    .optional()
    .describe("Optional relation type filter where applicable"),
  min_confidence: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe("Optional minimum confidence filter across relation sources"),
  direction: z.enum(["outbound", "inbound", "both"]).default("both"),
  include_vc: z.boolean().default(true),
  vc_limit_per_edge: z.number().int().min(0).max(20).default(5),
  limit: z.number().int().min(1).max(100).default(25),
});

export type GetRelatedInput = z.infer<typeof GetRelatedInput>;

export interface RelatedResult {
  subject: {
    id: string;
    kind: "hyobject" | "entity" | "person";
    name: string | null;
  };
  relations: RelatedEdge[];
  count: number;
}

interface RelatedEdge {
  edge_id: string;
  relation_table: "relatedhyperdocuments" | "hypeoplerelations" | "entity_relations" | "entity_mentions";
  relation_type_id: number | null;
  predicate: string | null;
  confidence: number;
  created_at: string;
  direction: "outbound" | "inbound";
  source: { id: string; kind: "hyobject" | "entity" | "person"; name: string | null };
  target: { id: string; kind: "hyobject" | "entity" | "person"; name: string | null };
  provenance: {
    source_hyobject_id: string | null;
    vc_trail: Array<{
      vc_id: number;
      operation: string;
      column_name: string;
      actor_kind: string;
      actor_id: string;
      reason: string | null;
      changed_at: string;
    }>;
  };
}

interface RelationSeed {
  edge_id: string;
  relation_table: RelatedEdge["relation_table"];
  relation_type_id: number | null;
  predicate: string | null;
  confidence: number;
  created_at: string;
  source_id: string;
  source_kind: "hyobject" | "entity" | "person";
  target_id: string;
  target_kind: "hyobject" | "entity" | "person";
  direction: "outbound" | "inbound";
  source_hyobject_id: string | null;
}

export async function getRelated(
  ctx: SessionContext,
  input: GetRelatedInput
): Promise<RelatedResult> {
  return withSession(ctx, async (client) => {
    const subject = await loadSubject(client, input.subject_kind, input.subject_id);
    if (!subject) {
      throw new Error(`${input.subject_kind} not found`);
    }

    const relationSeeds = await gatherSeeds(client, input);
    const limitedSeeds = relationSeeds.slice(0, input.limit);

    const uniqueNodeIds = new Set<string>();
    for (const seed of limitedSeeds) {
      uniqueNodeIds.add(seed.source_id);
      uniqueNodeIds.add(seed.target_id);
    }

    const nodeMap = await loadNodeNames(client, Array.from(uniqueNodeIds));

    const relations: RelatedEdge[] = [];
    for (const seed of limitedSeeds) {
      const vcTrail =
        input.include_vc && input.vc_limit_per_edge > 0
          ? await loadVcTrail(client, seed.relation_table, seed.edge_id, input.vc_limit_per_edge)
          : [];

      relations.push({
        edge_id: seed.edge_id,
        relation_table: seed.relation_table,
        relation_type_id: seed.relation_type_id,
        predicate: seed.predicate,
        confidence: seed.confidence,
        created_at: seed.created_at,
        direction: seed.direction,
        source: {
          id: seed.source_id,
          kind: seed.source_kind,
          name: nodeMap.get(seed.source_id) ?? null,
        },
        target: {
          id: seed.target_id,
          kind: seed.target_kind,
          name: nodeMap.get(seed.target_id) ?? null,
        },
        provenance: {
          source_hyobject_id: seed.source_hyobject_id,
          vc_trail: vcTrail,
        },
      });
    }

    return {
      subject,
      relations,
      count: relations.length,
    };
  });
}

async function loadSubject(
  client: PoolClient,
  kind: "hyobject" | "entity" | "person",
  id: string
): Promise<RelatedResult["subject"] | null> {
  if (kind === "hyobject") {
    const res = await client.query(`SELECT hyobject_id, name FROM hyobjects WHERE hyobject_id = $1 AND ${hyobjectVisibleSql("hyobjects")}`, [id]);
    if (res.rows.length === 0) return null;
    return { id: res.rows[0].hyobject_id, kind, name: res.rows[0].name };
  }

  if (kind === "entity") {
    const res = await client.query(`SELECT entity_id, canonical_name FROM entities WHERE entity_id = $1`, [id]);
    if (res.rows.length === 0) return null;
    return { id: res.rows[0].entity_id, kind, name: res.rows[0].canonical_name };
  }

  const res = await client.query(`SELECT people_id, display_name FROM people WHERE people_id = $1`, [id]);
  if (res.rows.length === 0) return null;
  return { id: res.rows[0].people_id, kind, name: res.rows[0].display_name };
}

async function gatherSeeds(client: PoolClient, input: GetRelatedInput): Promise<RelationSeed[]> {
  const mentionIdExpr = "COALESCE((to_jsonb(em)->>'id')::uuid, (to_jsonb(em)->>'mention_id')::uuid)";
  const mentionEntityExpr =
    "COALESCE((to_jsonb(em)->>'entity_id')::uuid, (to_jsonb(em)->>'mentioned_entity_id')::uuid, (to_jsonb(em)->>'subject_entity_id')::uuid)";
  const mentionHyobjectExpr =
    "COALESCE((to_jsonb(em)->>'hyobject_id')::uuid, (to_jsonb(em)->>'document_id')::uuid, (to_jsonb(em)->>'source_hyobject_id')::uuid)";
  const mentionConfidenceExpr = "COALESCE((to_jsonb(em)->>'confidence')::numeric, 1.0)";
  const mentionCreatedAtExpr = "COALESCE((to_jsonb(em)->>'created_at')::timestamptz, now())";
  const confidenceParam = input.min_confidence;
  const hasRelationTypeFilter = Boolean(input.relation_type_ids && input.relation_type_ids.length > 0);
  const limitParamIdx = hasRelationTypeFilter ? 4 : 3;
  const relationFilter =
    hasRelationTypeFilter
      ? "AND relation_type_id = ANY($2::int[])"
      : "";
  const relationParams =
    hasRelationTypeFilter ? [input.relation_type_ids] : [];

  const rows: RelationSeed[] = [];

  if (input.subject_kind === "hyobject") {
    if (input.direction !== "inbound") {
      const hhOutbound = await client.query(
        `SELECT id, relation_type_id, confidence, created_at, hyobject1_id, hyobject2_id
         FROM relatedhyperdocuments
         WHERE hyobject1_id = $1 ${relationFilter}
           AND confidence >= $${hasRelationTypeFilter ? 3 : 2}
         ORDER BY created_at DESC
         LIMIT $${limitParamIdx}`,
        [input.subject_id, ...relationParams, confidenceParam, input.limit]
      );
      for (const row of hhOutbound.rows) {
        rows.push(seedFromHyobjectEdge(row, "outbound", "hyobject", "hyobject"));
      }

      const hpOutbound = await client.query(
        `SELECT id, relation_type_id, confidence, created_at, hyobject_id, people_id, source_hyobject_id
         FROM hypeoplerelations
         WHERE hyobject_id = $1 ${relationFilter}
           AND confidence >= $${hasRelationTypeFilter ? 3 : 2}
         ORDER BY created_at DESC
         LIMIT $${limitParamIdx}`,
        [input.subject_id, ...relationParams, confidenceParam, input.limit]
      );
      for (const row of hpOutbound.rows) {
        rows.push({
          edge_id: row.id,
          relation_table: "hypeoplerelations",
          relation_type_id: row.relation_type_id,
          predicate: null,
          confidence: Number(row.confidence),
          created_at: row.created_at,
          source_id: row.hyobject_id,
          source_kind: "hyobject",
          target_id: row.people_id,
          target_kind: "person",
          direction: "outbound",
          source_hyobject_id: row.source_hyobject_id ?? null,
        });
      }

      const mentionOutbound = await client.query(
        `SELECT ${mentionIdExpr} AS edge_id,
                ${mentionEntityExpr} AS entity_id,
                ${mentionHyobjectExpr} AS hyobject_id,
                ${mentionConfidenceExpr} AS confidence,
                ${mentionCreatedAtExpr} AS created_at
         FROM entity_mentions
         em
         WHERE ${mentionHyobjectExpr} = $1
           AND ${mentionConfidenceExpr} >= $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [input.subject_id, confidenceParam, input.limit]
      );
      for (const row of mentionOutbound.rows) {
        rows.push({
          edge_id: row.edge_id,
          relation_table: "entity_mentions",
          relation_type_id: null,
          predicate: "mentions",
          confidence: Number(row.confidence),
          created_at: row.created_at,
          source_id: row.hyobject_id,
          source_kind: "hyobject",
          target_id: row.entity_id,
          target_kind: "entity",
          direction: "outbound",
          source_hyobject_id: row.hyobject_id,
        });
      }
    }

    if (input.direction !== "outbound") {
      const hhInbound = await client.query(
        `SELECT id, relation_type_id, confidence, created_at, hyobject1_id, hyobject2_id
         FROM relatedhyperdocuments
         WHERE hyobject2_id = $1 ${relationFilter}
           AND confidence >= $${hasRelationTypeFilter ? 3 : 2}
         ORDER BY created_at DESC
         LIMIT $${limitParamIdx}`,
        [input.subject_id, ...relationParams, confidenceParam, input.limit]
      );
      for (const row of hhInbound.rows) {
        rows.push(seedFromHyobjectEdge(row, "inbound", "hyobject", "hyobject"));
      }

      const mentionInbound = await client.query(
        `SELECT ${mentionIdExpr} AS edge_id,
                ${mentionEntityExpr} AS entity_id,
                ${mentionHyobjectExpr} AS hyobject_id,
                ${mentionConfidenceExpr} AS confidence,
                ${mentionCreatedAtExpr} AS created_at
         FROM entity_mentions
         em
         WHERE ${mentionEntityExpr} IN (
           SELECT COALESCE((to_jsonb(em2)->>'entity_id')::uuid, (to_jsonb(em2)->>'mentioned_entity_id')::uuid, (to_jsonb(em2)->>'subject_entity_id')::uuid)
           FROM entity_mentions em2
           WHERE COALESCE((to_jsonb(em2)->>'hyobject_id')::uuid, (to_jsonb(em2)->>'document_id')::uuid, (to_jsonb(em2)->>'source_hyobject_id')::uuid) = $1
         )
           AND ${mentionHyobjectExpr} <> $1
           AND ${mentionConfidenceExpr} >= $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [input.subject_id, confidenceParam, input.limit]
      );
      for (const row of mentionInbound.rows) {
        rows.push({
          edge_id: row.edge_id,
          relation_table: "entity_mentions",
          relation_type_id: null,
          predicate: "shares_entity",
          confidence: Number(row.confidence),
          created_at: row.created_at,
          source_id: row.hyobject_id,
          source_kind: "hyobject",
          target_id: input.subject_id,
          target_kind: "hyobject",
          direction: "inbound",
          source_hyobject_id: row.hyobject_id,
        });
      }
    }
  }

  if (input.subject_kind === "entity") {
    if (input.direction !== "inbound") {
      const erOutbound = await client.query(
        `SELECT id, predicate, confidence, created_at, source_hyobject_id, entity1_id, entity2_id
         FROM entity_relations
         WHERE entity1_id = $1
           AND confidence >= $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [input.subject_id, confidenceParam, input.limit]
      );
      for (const row of erOutbound.rows) {
        rows.push({
          edge_id: row.id,
          relation_table: "entity_relations",
          relation_type_id: null,
          predicate: row.predicate,
          confidence: Number(row.confidence),
          created_at: row.created_at,
          source_id: row.entity1_id,
          source_kind: "entity",
          target_id: row.entity2_id,
          target_kind: "entity",
          direction: "outbound",
          source_hyobject_id: row.source_hyobject_id ?? null,
        });
      }

      const mentionOutbound = await client.query(
        `SELECT ${mentionIdExpr} AS edge_id,
                ${mentionEntityExpr} AS entity_id,
                ${mentionHyobjectExpr} AS hyobject_id,
                ${mentionConfidenceExpr} AS confidence,
                ${mentionCreatedAtExpr} AS created_at
         FROM entity_mentions
         em
         WHERE ${mentionEntityExpr} = $1
           AND ${mentionConfidenceExpr} >= $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [input.subject_id, confidenceParam, input.limit]
      );
      for (const row of mentionOutbound.rows) {
        rows.push({
          edge_id: row.edge_id,
          relation_table: "entity_mentions",
          relation_type_id: null,
          predicate: "mentioned_in",
          confidence: Number(row.confidence),
          created_at: row.created_at,
          source_id: row.entity_id,
          source_kind: "entity",
          target_id: row.hyobject_id,
          target_kind: "hyobject",
          direction: "outbound",
          source_hyobject_id: row.hyobject_id,
        });
      }
    }

    if (input.direction !== "outbound") {
      const erInbound = await client.query(
        `SELECT id, predicate, confidence, created_at, source_hyobject_id, entity1_id, entity2_id
         FROM entity_relations
         WHERE entity2_id = $1
           AND confidence >= $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [input.subject_id, confidenceParam, input.limit]
      );
      for (const row of erInbound.rows) {
        rows.push({
          edge_id: row.id,
          relation_table: "entity_relations",
          relation_type_id: null,
          predicate: row.predicate,
          confidence: Number(row.confidence),
          created_at: row.created_at,
          source_id: row.entity1_id,
          source_kind: "entity",
          target_id: row.entity2_id,
          target_kind: "entity",
          direction: "inbound",
          source_hyobject_id: row.source_hyobject_id ?? null,
        });
      }
    }
  }

  if (input.subject_kind === "person") {
    if (input.direction !== "inbound") {
      const personOutbound = await client.query(
        `SELECT id, relation_type_id, confidence, created_at, source_hyobject_id, people_id, hyobject_id
         FROM hypeoplerelations
         WHERE people_id = $1 ${relationFilter}
           AND confidence >= $${hasRelationTypeFilter ? 3 : 2}
         ORDER BY created_at DESC
         LIMIT $${limitParamIdx}`,
        [input.subject_id, ...relationParams, confidenceParam, input.limit]
      );
      for (const row of personOutbound.rows) {
        rows.push({
          edge_id: row.id,
          relation_table: "hypeoplerelations",
          relation_type_id: row.relation_type_id,
          predicate: "related_to_document",
          confidence: Number(row.confidence),
          created_at: row.created_at,
          source_id: row.people_id,
          source_kind: "person",
          target_id: row.hyobject_id,
          target_kind: "hyobject",
          direction: "outbound",
          source_hyobject_id: row.source_hyobject_id ?? null,
        });
      }
    }

    if (input.direction !== "outbound") {
      const personInbound = await client.query(
        `SELECT id, relation_type_id, confidence, created_at, source_hyobject_id, people_id, hyobject_id
         FROM hypeoplerelations
         WHERE people_id = $1 ${relationFilter}
           AND confidence >= $${hasRelationTypeFilter ? 3 : 2}
         ORDER BY created_at DESC
         LIMIT $${limitParamIdx}`,
        [input.subject_id, ...relationParams, confidenceParam, input.limit]
      );
      for (const row of personInbound.rows) {
        rows.push({
          edge_id: row.id,
          relation_table: "hypeoplerelations",
          relation_type_id: row.relation_type_id,
          predicate: "related_from_document",
          confidence: Number(row.confidence),
          created_at: row.created_at,
          source_id: row.hyobject_id,
          source_kind: "hyobject",
          target_id: row.people_id,
          target_kind: "person",
          direction: "inbound",
          source_hyobject_id: row.source_hyobject_id ?? null,
        });
      }
    }
  }

  const targetFilter = input.target_kinds && input.target_kinds.length > 0 ? new Set(input.target_kinds) : null;
  return rows
    .filter((r) => r.confidence >= input.min_confidence)
    .filter((r) => (targetFilter ? targetFilter.has(r.target_kind) : true))
    .sort((a, b) => (a.created_at > b.created_at ? -1 : a.created_at < b.created_at ? 1 : 0));
}

function seedFromHyobjectEdge(
  row: {
    id: string;
    relation_type_id: number | null;
    confidence: number | string;
    created_at: string;
    hyobject1_id: string;
    hyobject2_id: string;
  },
  direction: "outbound" | "inbound",
  sourceKind: "hyobject",
  targetKind: "hyobject"
): RelationSeed {
  return {
    edge_id: row.id,
    relation_table: "relatedhyperdocuments",
    relation_type_id: row.relation_type_id,
    predicate: null,
    confidence: Number(row.confidence),
    created_at: row.created_at,
    source_id: row.hyobject1_id,
    source_kind: sourceKind,
    target_id: row.hyobject2_id,
    target_kind: targetKind,
    direction,
    source_hyobject_id: row.hyobject1_id,
  };
}

async function loadNodeNames(client: PoolClient, ids: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (ids.length === 0) return map;

  const hy = await client.query(
    `SELECT hyobject_id AS id, name FROM hyobjects WHERE hyobject_id = ANY($1::uuid[]) AND ${hyobjectVisibleSql("hyobjects")}`,
    [ids]
  );
  for (const row of hy.rows) map.set(row.id, row.name ?? null);

  const en = await client.query(
    `SELECT entity_id AS id, canonical_name AS name FROM entities WHERE entity_id = ANY($1::uuid[])`,
    [ids]
  );
  for (const row of en.rows) map.set(row.id, row.name ?? null);

  const pe = await client.query(
    `SELECT people_id AS id, display_name AS name FROM people WHERE people_id = ANY($1::uuid[])`,
    [ids]
  );
  for (const row of pe.rows) map.set(row.id, row.name ?? null);

  return map;
}

async function loadVcTrail(
  client: PoolClient,
  tableName: string,
  rowId: string,
  limit: number
): Promise<RelatedEdge["provenance"]["vc_trail"]> {
  const res = await client.query(
    `SELECT vc_id, operation, column_name, actor_kind, actor_id, reason, changed_at
     FROM vc
     WHERE table_name = $1 AND row_id = $2
     ORDER BY changed_at DESC
     LIMIT $3`,
    [tableName, rowId, limit]
  );
  return res.rows;
}
