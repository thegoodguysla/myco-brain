/**
 * brain_propose_fact — agent fact/entity/relation proposals.
 *
 * Agents use this to propose new entities or relationships they've inferred.
 * Proposals land in proposed_entities / proposed_relations with state='pending'
 * and go through the review pipeline before becoming canonical knowledge.
 */
import { z } from "zod";
import { withSession, type SessionContext } from "../db.js";

const EntityProposal = z.object({
  kind: z.literal("entity"),
  entity_kind_id: z.number().int().describe("entity_kinds.kind_id"),
  canonical_name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  source_hyobject_id: z.string().uuid().describe("Source document"),
  confidence: z.number().min(0).max(1).default(0.8),
});

const RelationProposal = z.object({
  kind: z.literal("relation"),
  subject_kind: z.enum(["hyobject", "person", "entity"]),
  subject_id: z.string().uuid(),
  object_kind: z.enum(["hyobject", "person", "entity"]),
  object_id: z.string().uuid(),
  predicate: z.string().optional().describe("Free-text predicate for entity–entity"),
  relation_type_id: z.number().int().optional().describe("relation_types.relation_type_id"),
  source_hyobject_id: z.string().uuid().optional(),
  confidence: z.number().min(0).max(1).default(0.8),
});

export const ProposeFactInput = z.discriminatedUnion("kind", [
  EntityProposal,
  RelationProposal,
]);

export type ProposeFactInput = z.infer<typeof ProposeFactInput>;

export interface ProposeFactResult {
  proposal_id: string;
  kind: "entity" | "relation";
  state: string;
  message: string;
}

export async function proposeFact(
  ctx: SessionContext,
  input: ProposeFactInput
): Promise<ProposeFactResult> {
  return withSession(
    { ...ctx, actorKind: "agent", reason: "proposal" },
    async (client) => {
      const extractedBy = `agent:${ctx.actorId}`;

      if (input.kind === "entity") {
        const res = await client.query(
          `INSERT INTO proposed_entities
             (workspace_id, kind_id, canonical_name, aliases,
              source_hyobject_id, extracted_by, confidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, state`,
          [
            ctx.workspaceId,
            input.entity_kind_id,
            input.canonical_name,
            input.aliases,
            input.source_hyobject_id,
            extractedBy,
            input.confidence,
          ]
        );
        return {
          proposal_id: res.rows[0].id,
          kind: "entity",
          state: res.rows[0].state,
          message: `Entity proposal created: "${input.canonical_name}". Awaiting review.`,
        };
      } else {
        const res = await client.query(
          `INSERT INTO proposed_relations
             (workspace_id, subject_kind, subject_id, object_kind, object_id,
              predicate, relation_type_id, source_hyobject_id, extracted_by, confidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id, state`,
          [
            ctx.workspaceId,
            input.subject_kind,
            input.subject_id,
            input.object_kind,
            input.object_id,
            input.predicate ?? null,
            input.relation_type_id ?? null,
            input.source_hyobject_id ?? null,
            extractedBy,
            input.confidence,
          ]
        );
        return {
          proposal_id: res.rows[0].id,
          kind: "relation",
          state: res.rows[0].state,
          message: `Relation proposal created between ${input.subject_kind}:${input.subject_id} and ${input.object_kind}:${input.object_id}. Awaiting review.`,
        };
      }
    }
  );
}
