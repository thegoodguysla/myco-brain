/**
 * brain_annotate — agent breadcrumb notes.
 *
 * Agents leave short session notes attached to the current agent session.
 * Notes are stored in agent_session_notes and can be:
 *   - observation  — something the agent noticed
 *   - decision     — a choice the agent made and why
 *   - question     — something the agent needs answered
 *   - fact         — a fact the agent wants to record (soft; use propose_fact for canonical facts)
 *
 * Notes can also be promoted to hyobject proposals later via the promoted_to field.
 */
import { z } from "zod";
import { withSession, type SessionContext } from "../db.js";

export const AnnotateInput = z.object({
  kind: z.enum(["observation", "decision", "question", "fact"]),
  content: z.string().min(1).describe("The note content"),
  session_id: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Existing session to attach to. If omitted, a new session is created for this agent."
    ),
  related_hyobject_id: z
    .string()
    .uuid()
    .optional()
    .describe("Hyobject this note is about (optional)"),
});

export type AnnotateInput = z.infer<typeof AnnotateInput>;

export interface AnnotateResult {
  note_id: string;
  session_id: string;
  kind: string;
  content: string;
  created_at: string;
}

export async function annotate(
  ctx: SessionContext,
  input: AnnotateInput
): Promise<AnnotateResult> {
  return withSession(ctx, async (client) => {
    // Resolve or create session
    let sessionId = input.session_id;

    if (!sessionId) {
      // Find the most recent open session for this agent in this workspace
      const existing = await client.query(
        `SELECT session_id FROM agent_sessions
         WHERE workspace_id = $1 AND agent_id = $2 AND ended_at IS NULL
         ORDER BY started_at DESC
         LIMIT 1`,
        [ctx.workspaceId, ctx.actorId]
      );

      if (existing.rows.length > 0) {
        sessionId = existing.rows[0].session_id;
      } else {
        // Create a new session
        const newSession = await client.query(
          `INSERT INTO agent_sessions (workspace_id, agent_id)
           VALUES ($1, $2)
           RETURNING session_id`,
          [ctx.workspaceId, ctx.actorId]
        );
        sessionId = newSession.rows[0].session_id;
      }
    }

    // Insert the note
    const res = await client.query(
      `INSERT INTO agent_session_notes (session_id, workspace_id, kind, content)
       VALUES ($1, $2, $3, $4)
       RETURNING note_id, session_id, kind, content, created_at`,
      [sessionId, ctx.workspaceId, input.kind, input.content]
    );

    const row = res.rows[0];

    return {
      note_id: row.note_id,
      session_id: row.session_id,
      kind: row.kind,
      content: row.content,
      created_at: row.created_at,
    };
  });
}
