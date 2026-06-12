/**
 * brain_neighbors — graph traversal.
 *
 * Returns the neighbourhood of a node in the knowledge graph:
 *   - Hyobject ↔ Hyobject relations (relatedhyperdocuments)
 *   - Hyobject ↔ People relations (hypeoplerelations)
 *   - Entity ↔ Entity relations (entity_relations)
 *   - Entity mentions across hyobjects (entity_mentions)
 *   - Agent ↔ Hyobject edges (hyobjects.agent_id + relation_evidence)
 *   - Agent ↔ Agent edges (relation_evidence)
 *
 * Supports 1-hop (direct neighbours) or 2-hop traversal.
 */
import { z } from "zod";
import { withSession, type SessionContext } from "../db.js";
import { hyobjectVisibleSql } from "../sharing.js";

export const NeighborsInput = z.object({
  node_id: z.string().uuid().describe("hyobject_id, entity_id, people_id, or agent_id"),
  node_kind: z.enum(["hyobject", "entity", "person", "agent"]),
  depth: z.number().int().min(1).max(2).default(1),
  relation_types: z
    .array(z.number().int())
    .optional()
    .describe("Filter to specific relation_type_ids"),
  limit: z.number().int().min(1).max(100).default(20),
});

export type NeighborsInput = z.infer<typeof NeighborsInput>;

export interface NeighborsResult {
  edges: Edge[];
  nodes: Node[];
}

interface Edge {
  edge_id: string;
  from_id: string;
  from_kind: string;
  to_id: string;
  to_kind: string;
  relation_type_id: number | null;
  predicate: string | null;
  confidence: number;
  created_at: string;
}

interface Node {
  id: string;
  kind: string;
  name: string | null;
  type_id?: number;
  kind_id?: number;
}

export async function neighbors(
  ctx: SessionContext,
  input: NeighborsInput
): Promise<NeighborsResult> {
  return withSession(ctx, async (client) => {
    const edges: Edge[] = [];
    const nodeMap = new Map<string, Node>();

    const typeFilter =
      input.relation_types && input.relation_types.length > 0
        ? `AND relation_type_id = ANY($3::int[])`
        : "";
    const typeParams =
      input.relation_types && input.relation_types.length > 0
        ? [input.relation_types]
        : [];

    if (input.node_kind === "hyobject") {
      // hyobject ↔ hyobject
      const hhRes = await client.query(
        `SELECT id, hyobject1_id, hyobject2_id, relation_type_id, confidence, created_at
         FROM relatedhyperdocuments
         WHERE (hyobject1_id = $1 OR hyobject2_id = $1)
           ${typeFilter}
         ORDER BY priority DESC, confidence DESC
         LIMIT $2`,
        [input.node_id, input.limit, ...typeParams]
      );
      for (const row of hhRes.rows) {
        edges.push({
          edge_id: row.id,
          from_id: row.hyobject1_id,
          from_kind: "hyobject",
          to_id: row.hyobject2_id,
          to_kind: "hyobject",
          relation_type_id: row.relation_type_id,
          predicate: null,
          confidence: row.confidence,
          created_at: row.created_at,
        });
        nodeMap.set(row.hyobject1_id, {
          id: row.hyobject1_id,
          kind: "hyobject",
          name: null,
        });
        nodeMap.set(row.hyobject2_id, {
          id: row.hyobject2_id,
          kind: "hyobject",
          name: null,
        });
      }

      // hyobject ↔ people
      const hpRes = await client.query(
        `SELECT id, people_id, hyobject_id, relation_type_id, confidence, created_at
         FROM hypeoplerelations
         WHERE hyobject_id = $1
           AND (valid_to IS NULL OR valid_to > now())
           ${typeFilter}
         LIMIT $2`,
        [input.node_id, input.limit, ...typeParams]
      );
      for (const row of hpRes.rows) {
        edges.push({
          edge_id: row.id,
          from_id: row.hyobject_id,
          from_kind: "hyobject",
          to_id: row.people_id,
          to_kind: "person",
          relation_type_id: row.relation_type_id,
          predicate: null,
          confidence: row.confidence,
          created_at: row.created_at,
        });
        nodeMap.set(row.people_id, {
          id: row.people_id,
          kind: "person",
          name: null,
        });
      }

      // entity mentions in this hyobject
      const emRes = await client.query(
        `SELECT em.id, em.entity_id, em.hyobject_id, em.confidence, em.created_at,
                e.canonical_name, e.kind_id
         FROM entity_mentions em
         JOIN entities e ON e.entity_id = em.entity_id
         WHERE em.hyobject_id = $1
         LIMIT $2`,
        [input.node_id, input.limit]
      );
      for (const row of emRes.rows) {
        edges.push({
          edge_id: row.id,
          from_id: row.hyobject_id,
          from_kind: "hyobject",
          to_id: row.entity_id,
          to_kind: "entity",
          relation_type_id: null,
          predicate: "mentions",
          confidence: row.confidence,
          created_at: row.created_at,
        });
        nodeMap.set(row.entity_id, {
          id: row.entity_id,
          kind: "entity",
          name: row.canonical_name,
          kind_id: row.kind_id,
        });
      }
    } else if (input.node_kind === "entity") {
      // entity ↔ entity
      const eeRes = await client.query(
        `SELECT id, entity1_id, entity2_id, predicate, relation_type_id, confidence, created_at
         FROM entity_relations
         WHERE (entity1_id = $1 OR entity2_id = $1)
           AND (valid_to IS NULL OR valid_to > now())
         LIMIT $2`,
        [input.node_id, input.limit]
      );
      for (const row of eeRes.rows) {
        edges.push({
          edge_id: row.id,
          from_id: row.entity1_id,
          from_kind: "entity",
          to_id: row.entity2_id,
          to_kind: "entity",
          relation_type_id: row.relation_type_id,
          predicate: row.predicate,
          confidence: row.confidence,
          created_at: row.created_at,
        });
        nodeMap.set(row.entity1_id, {
          id: row.entity1_id,
          kind: "entity",
          name: null,
        });
        nodeMap.set(row.entity2_id, {
          id: row.entity2_id,
          kind: "entity",
          name: null,
        });
      }

      // hyobjects that mention this entity
      const emRes = await client.query(
        `SELECT em.id, em.entity_id, em.hyobject_id, em.confidence, em.created_at,
                h.name, h.type_id
         FROM entity_mentions em
         JOIN hyobjects h ON h.hyobject_id = em.hyobject_id AND ${hyobjectVisibleSql("h")}
         WHERE em.entity_id = $1
         LIMIT $2`,
        [input.node_id, input.limit]
      );
      for (const row of emRes.rows) {
        edges.push({
          edge_id: row.id,
          from_id: row.entity_id,
          from_kind: "entity",
          to_id: row.hyobject_id,
          to_kind: "hyobject",
          relation_type_id: null,
          predicate: "mentioned_in",
          confidence: row.confidence,
          created_at: row.created_at,
        });
        nodeMap.set(row.hyobject_id, {
          id: row.hyobject_id,
          kind: "hyobject",
          name: row.name,
          type_id: row.type_id,
        });
      }
    } else if (input.node_kind === "agent") {
      // Agent: find hyobjects owned by this agent
      const hRes = await client.query(
        `SELECT hyobject_id, name, type_id, agent_id
         FROM hyobjects
         WHERE agent_id = $1 AND workspace_id = $2 AND ${hyobjectVisibleSql("hyobjects")}
         ORDER BY created_at DESC
         LIMIT $3`,
        [input.node_id, ctx.workspaceId, input.limit]
      );
      for (const row of hRes.rows) {
        edges.push({
          edge_id: row.hyobject_id,
          from_id: row.agent_id,
          from_kind: "agent",
          to_id: row.hyobject_id,
          to_kind: "hyobject",
          relation_type_id: null,
          predicate: "owns_memory",
          confidence: 1,
          created_at: new Date().toISOString(),
        });
        nodeMap.set(row.hyobject_id, {
          id: row.hyobject_id,
          kind: "hyobject",
          name: row.name,
          type_id: row.type_id,
        });
      }

      // Agent: evidence-backed agent→memory edges
      const evRes = await client.query(
        `SELECT id, source_node_id, target_node_id, predicate, CAST(confidence AS float) AS confidence, created_at
         FROM relation_evidence
         WHERE workspace_id = $1
           AND relation_kind = 'agent_memory'
           AND source_node_id = $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [ctx.workspaceId, input.node_id, input.limit]
      );
      for (const row of evRes.rows) {
        edges.push({
          edge_id: row.id ?? row.target_node_id,
          from_id: row.source_node_id,
          from_kind: "agent",
          to_id: row.target_node_id,
          to_kind: "hyobject",
          relation_type_id: null,
          predicate: row.predicate,
          confidence: row.confidence,
          created_at: row.created_at,
        });
        nodeMap.set(row.target_node_id, {
          id: row.target_node_id,
          kind: "hyobject",
          name: null,
        });
      }

      // Agent: agent→agent edges
      const aaRes = await client.query(
        `SELECT id, source_node_id, target_node_id, predicate, CAST(confidence AS float) AS confidence, created_at
         FROM relation_evidence
         WHERE workspace_id = $1
           AND relation_kind = 'agent_agent'
           AND (source_node_id = $2 OR target_node_id = $2)
         ORDER BY created_at DESC
         LIMIT $3`,
        [ctx.workspaceId, input.node_id, input.limit]
      );
      for (const row of aaRes.rows) {
        const isSource = row.source_node_id === input.node_id;
        edges.push({
          edge_id: row.id ?? row.target_node_id,
          from_id: row.source_node_id,
          from_kind: "agent",
          to_id: row.target_node_id,
          to_kind: "agent",
          relation_type_id: null,
          predicate: row.predicate,
          confidence: row.confidence,
          created_at: row.created_at,
        });
        const otherId = isSource ? row.target_node_id : row.source_node_id;
        nodeMap.set(otherId, {
          id: otherId,
          kind: "agent",
          name: null,
        });
      }
    } else {
      // person ↔ hyobject
      const phRes = await client.query(
        `SELECT id, people_id, hyobject_id, relation_type_id, confidence, created_at
         FROM hypeoplerelations
         WHERE people_id = $1
           AND (valid_to IS NULL OR valid_to > now())
           ${typeFilter}
         LIMIT $2`,
        [input.node_id, input.limit, ...typeParams]
      );
      for (const row of phRes.rows) {
        edges.push({
          edge_id: row.id,
          from_id: row.people_id,
          from_kind: "person",
          to_id: row.hyobject_id,
          to_kind: "hyobject",
          relation_type_id: row.relation_type_id,
          predicate: null,
          confidence: row.confidence,
          created_at: row.created_at,
        });
        nodeMap.set(row.hyobject_id, {
          id: row.hyobject_id,
          kind: "hyobject",
          name: null,
        });
      }

      // person ↔ person
      const ppRes = await client.query(
        `SELECT id, people1_id, people2_id, relation_type_id, confidence, created_at
         FROM peoplerelations
         WHERE (people1_id = $1 OR people2_id = $1)
           AND (end_date IS NULL OR end_date > CURRENT_DATE)
           ${typeFilter}
         LIMIT $2`,
        [input.node_id, input.limit, ...typeParams]
      );
      for (const row of ppRes.rows) {
        edges.push({
          edge_id: row.id,
          from_id: row.people1_id,
          from_kind: "person",
          to_id: row.people2_id,
          to_kind: "person",
          relation_type_id: row.relation_type_id,
          predicate: null,
          confidence: row.confidence,
          created_at: row.created_at,
        });
        nodeMap.set(row.people1_id, {
          id: row.people1_id,
          kind: "person",
          name: null,
        });
        nodeMap.set(row.people2_id, {
          id: row.people2_id,
          kind: "person",
          name: null,
        });
      }
    }

    // Enrich unlabelled hyobject nodes with names
    const hyobjectIds = [...nodeMap.values()]
      .filter((n) => n.kind === "hyobject" && !n.name)
      .map((n) => n.id);
    if (hyobjectIds.length > 0) {
      const nameRes = await client.query(
        `SELECT hyobject_id, name, type_id FROM hyobjects WHERE hyobject_id = ANY($1::uuid[]) AND ${hyobjectVisibleSql("hyobjects")}`,
        [hyobjectIds]
      );
      for (const row of nameRes.rows) {
        const node = nodeMap.get(row.hyobject_id);
        if (node) {
          node.name = row.name;
          node.type_id = row.type_id;
        }
      }
    }

    // Enrich unlabelled agent nodes with display names
    const agentIds = [...nodeMap.values()]
      .filter((n) => n.kind === "agent" && !n.name)
      .map((n) => n.id);
    if (agentIds.length > 0) {
      const agentRes = await client.query(
        `SELECT agent_id, display_name FROM agents WHERE agent_id = ANY($1::text[])`,
        [agentIds]
      );
      for (const row of agentRes.rows) {
        const node = nodeMap.get(row.agent_id);
        if (node) {
          node.name = row.display_name?.trim() || `Agent ${row.agent_id.slice(0, 8)}`;
        }
      }
    }

    // Always include the root node
    nodeMap.set(input.node_id, {
      id: input.node_id,
      kind: input.node_kind,
      name: null,
    });

    return {
      edges,
      nodes: [...nodeMap.values()],
    };
  });
}
