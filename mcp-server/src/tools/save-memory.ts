/**
 * brain_save_memory — agent memory ingestion with idempotency + trace enforcement.
 *
 * Every memory write carries idempotency_key, trace_id/span_id, raw_payload,
 * and summary/content. Writes are validated and deduplicated via the
 * memory-write-wrapper before persisting hyobjects, chunks, sessions, and
 * session notes.
 */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { withSession, type SessionContext } from "../db.js";
import { sanitize } from "../sanitize.js";
import { writeMemory, type MemoryWriteResult } from "../memory-write-wrapper.js";
import { materializeAgentMemoryEdge } from "../materialize-evidence.js";
import { embedAndStoreChunks } from "../embed.js";

export const SaveMemoryInput = z.object({
  content: z.string().min(1).describe("The derived summary of the memory (slim, searchable)"),
  tags: z
    .record(z.string())
    .optional()
    .describe("Key-value tags for filtering (e.g. {project: 'myco', topic: 'graph'})"),
  source_label: z
    .string()
    .default("agent_memory")
    .describe("Label for the source of this memory (default: agent_memory)"),

  // Mandatory idempotency + trace fields
  // Contract fields — auto-generated when the caller doesn't supply them, so
  // a bare {content: "..."} call (the shape every MCP agent uses) just works.
  // Pass your own idempotency_key when you need retry-safe writes.
  idempotency_key: z
    .string()
    .min(1)
    .default(() => randomUUID())
    .describe("Unique key for idempotent writes (same key = same write). Auto-generated if omitted."),
  trace_id: z
    .string()
    .min(1)
    .default(() => randomUUID())
    .describe("End-to-end trace identifier for causal chain propagation. Auto-generated if omitted."),
  span_id: z
    .string()
    .optional()
    .describe("Operation-level span identifier. Auto-generated if not provided."),
  causal_parent_id: z
    .string()
    .optional()
    .describe("Parent span in the causal chain."),
  raw_payload: z
    .record(z.unknown())
    .default({})
    .describe("The raw/original event payload (full transcript, tool output, …). Defaults to {}."),
});

export type SaveMemoryInput = z.infer<typeof SaveMemoryInput>;

export interface SaveMemoryResult {
  hyobject_id: string;
  note_id: string;
  session_id: string;
  event_id: string;
  created: boolean;
  span_id: string;
  trace_id: string;
  message: string;
}

export async function saveMemory(
  ctx: SessionContext,
  input: SaveMemoryInput
): Promise<SaveMemoryResult> {
  return withSession(
    { ...ctx, actorKind: "agent", reason: "agent_memory" },
    async (client) => {
      // Strip injected memory tags before persisting
      const content = sanitize(input.content);

      // Write through the mandatory memory contract wrapper
      const writeResult: MemoryWriteResult = await writeMemory(client, ctx, {
        idempotency_key: input.idempotency_key,
        trace_id: input.trace_id,
        span_id: input.span_id,
        causal_parent_id: input.causal_parent_id,
        raw_payload: input.raw_payload,
        summary: content,
        kind: "save_memory",
      });

      // Build metadata
      const metadata: Record<string, unknown> = {
        source_label: input.source_label,
        ...(input.tags ?? {}),
        // Propagate trace metadata
        trace_id: input.trace_id,
        span_id: writeResult.span_id,
        causal_parent_id: input.causal_parent_id ?? null,
      };

      const name =
        content.length > 120
          ? content.slice(0, 117) + "..."
          : content;

      // 1. Create hyobject (agent-scoped, done immediately)
      const hyRes = await client.query(
        `INSERT INTO hyobjects
           (workspace_id, type_id, subtype_id, name, agent_id,
            sharing_type_id, processing_state, content_tsv)
         VALUES ($1, 80, 200, $2, $3, 2, 'done', to_tsvector('english', $4))
         RETURNING hyobject_id`,
         [ctx.workspaceId, name, ctx.actorId, content]
      );

      const hyobjectId = hyRes.rows[0].hyobject_id;

      // 2. Create a chunk entry (for future vector search, full-text works via content_tsv)
      const chunkRes = await client.query(
        `INSERT INTO chunks (hyobject_id, workspace_id, chunk_index, text, metadata)
         VALUES ($1, $2, 0, $3, $4)
         RETURNING chunk_id`,
        [hyobjectId, ctx.workspaceId, content, JSON.stringify(metadata)]
      );
      const chunkId = chunkRes.rows[0].chunk_id;

      // Embed and store vector — best-effort, non-blocking
      embedAndStoreChunks(client, [{ chunk_id: chunkId, text: content }]).catch(
        (err) => console.error("[save_memory] embedding failed (non-fatal):", err)
      );

      // Materialize agent→memory evidence edge
      await materializeAgentMemoryEdge(
        client,
        ctx.workspaceId,
        ctx.actorId,
        hyobjectId,
        "saved_memory",
        {
          relationRowId: writeResult.event_id,
          evidenceChunkId: chunkId,
          confidence: 1.0,
          metadata: {
            idempotency_key: input.idempotency_key,
            trace_id: input.trace_id,
            source_label: input.source_label,
          },
        }
      );

      // 3. Resolve or create session for annotation
      const existing = await client.query(
        `SELECT session_id FROM agent_sessions
         WHERE workspace_id = $1 AND agent_id = $2 AND ended_at IS NULL
         ORDER BY started_at DESC
         LIMIT 1`,
        [ctx.workspaceId, ctx.actorId]
      );

      let sessionId: string;
      if (existing.rows.length > 0) {
        sessionId = existing.rows[0].session_id;
      } else {
        const newSession = await client.query(
          `INSERT INTO agent_sessions (workspace_id, agent_id)
           VALUES ($1, $2)
           RETURNING session_id`,
          [ctx.workspaceId, ctx.actorId]
        );
        sessionId = newSession.rows[0].session_id;
      }

      // 4. Create session note with trace lineage
      const noteRes = await client.query(
        `INSERT INTO agent_session_notes
           (session_id, workspace_id, agent_id, kind, content,
            idempotency_key, trace_id, span_id, causal_parent_id,
            raw_payload, summary)
         VALUES ($1, $2, $3, 'fact', $4, $5, $6, $7, $8, $9, $10)
         RETURNING note_id`,
        [
          sessionId,
          ctx.workspaceId,
          ctx.actorId,
          content,
          input.idempotency_key,
          input.trace_id,
          writeResult.span_id,
          input.causal_parent_id ?? null,
          JSON.stringify(input.raw_payload),
          content,
        ]
      );

      const createdLabel = writeResult.created ? "created" : "idempotent replay";
      return {
        hyobject_id: hyobjectId,
        note_id: noteRes.rows[0].note_id,
        session_id: sessionId,
        event_id: writeResult.event_id,
        created: writeResult.created,
        span_id: writeResult.span_id,
        trace_id: input.trace_id,
        message:
          `Memory ${createdLabel}. hyobject_id=${hyobjectId}, ` +
          `note_id=${noteRes.rows[0].note_id}, event_id=${writeResult.event_id}, ` +
          `trace_id=${input.trace_id}, span_id=${writeResult.span_id}. ` +
          "Full-text searchable immediately. Use brain_recall_memory to retrieve.",
      };
    }
  );
}
