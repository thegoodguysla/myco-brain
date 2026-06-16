import type { SessionContext } from "./db.js";
import { withSession } from "./db.js";
import { AuthError, parseBrainApiKey } from "./auth.js";

export interface CanonicalizeAgentContextOptions {
  rawApiKey?: string;
  /**
   * When true, rejects agent auth if no registered secret exists in
   * agent_api_keys. Default false for backward compatibility.
   */
  requireSecretVerification?: boolean;
}

function shouldRequireSecretVerification(
  opts: CanonicalizeAgentContextOptions | undefined
): boolean {
  return (
    opts?.requireSecretVerification === true ||
    process.env.BRAIN_REQUIRE_API_KEY_SECRET === "1"
  );
}

async function verifyAgentApiKeySecret(
  client: import("pg").PoolClient,
  ctx: SessionContext,
  rawApiKey: string,
  requireSecretVerification: boolean
): Promise<void> {
  if (!rawApiKey.startsWith("brain_")) return;
  const parsed = parseBrainApiKey(rawApiKey);
  if (parsed.workspaceId !== ctx.workspaceId || parsed.agentId !== ctx.actorId) {
    throw new AuthError("invalid API key");
  }

  try {
    const keyRow = await client.query(
      `SELECT secret_hash
         FROM agent_api_keys
        WHERE workspace_id = $1
          AND agent_id = $2
        LIMIT 1`,
      [ctx.workspaceId, ctx.actorId]
    );

    if (keyRow.rows.length === 0) {
      if (requireSecretVerification) {
        throw new AuthError(
          "API key secret verification is required, but no secret is registered " +
            "for this agent. Register one with brain_set_agent_api_key_secret(...)."
        );
      }
      return;
    }

    const secretHash = keyRow.rows[0].secret_hash as string;
    const verified = await client.query(
      `SELECT crypt($1, $2) = $2 AS ok`,
      [parsed.secret, secretHash]
    );
    if (!verified.rows[0]?.ok) {
      throw new AuthError("invalid API key");
    }

    // Best-effort last-used marker for rotated-key hygiene and audits.
    await client
      .query(
        `UPDATE agent_api_keys
            SET last_used_at = now()
          WHERE workspace_id = $1
            AND agent_id = $2`,
        [ctx.workspaceId, ctx.actorId]
      )
      .catch(() => {});
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "42P01" || code === "42883") {
      if (requireSecretVerification) {
        throw new AuthError(
          "API key secret verification is required, but the database migration " +
            "for agent_api_keys/pgcrypto has not been applied."
        );
      }
      return;
    }
    throw err;
  }
}

/**
 * Canonicalize caller actor_id through agent_bindings when the caller is a Paperclip UUID.
 * This prevents duplicate logical agents (paperclip UUID + brain_agent_id) from being persisted.
 */
export async function canonicalizeAgentContext(
  ctx: SessionContext,
  opts?: CanonicalizeAgentContextOptions
): Promise<SessionContext> {
  if (ctx.principalRole !== "agent") {
    return ctx;
  }

  const requireSecretVerification = shouldRequireSecretVerification(opts);

  return withSession(
    { ...ctx, actorKind: "agent", reason: "resolve_agent_binding" },
    async (client) => {
      if (opts?.rawApiKey) {
        await verifyAgentApiKeySecret(
          client,
          ctx,
          opts.rawApiKey,
          requireSecretVerification
        );
      }

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
