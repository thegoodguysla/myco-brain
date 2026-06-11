import type { SessionContext } from "./db.js";
import { withSession } from "./db.js";

/**
 * Canonicalize caller actor_id through agent_bindings when the caller is a Paperclip UUID.
 * This prevents duplicate logical agents (paperclip UUID + brain_agent_id) from being persisted.
 */
export async function canonicalizeAgentContext(
  ctx: SessionContext
): Promise<SessionContext> {
  if (ctx.principalRole !== "agent") {
    return ctx;
  }

  return withSession(
    { ...ctx, actorKind: "agent", reason: "resolve_agent_binding" },
    async (client) => {
      const res = await client.query(
        `SELECT brain_agent_id
           FROM agent_bindings
          WHERE workspace_id = $1
            AND paperclip_agent_id = $2
            AND is_active = true
          LIMIT 1`,
        [ctx.workspaceId, ctx.actorId]
      );

      if (res.rows.length === 0) {
        return ctx;
      }

      const canonicalActorId = res.rows[0].brain_agent_id as string;
      if (!canonicalActorId || canonicalActorId === ctx.actorId) {
        return ctx;
      }

      return { ...ctx, actorId: canonicalActorId };
    }
  );
}
