/**
 * Authentication for Brain MCP server.
 *
 * Supports two modes:
 *   1. BRAIN_SERVICE_ROLE_KEY — Supabase service-role JWT (full access, bypasses RLS)
 *      Used by system-level callers; workspace_id and actor_id still required in request.
 *   2. BRAIN_API_KEY — Per-agent API key in the format:
 *      brain_<workspaceId>_<agentId>_<secret>
 *      Encodes workspace and actor identity directly.
 *
 * The resolved identity is returned as a SessionContext for db.ts to apply via SET LOCAL.
 */

import type { SessionContext } from "./db.js";

export interface AuthResult {
  ctx: SessionContext;
  rawKey: string;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Resolve authentication from request parameters.
 *
 * Callers pass auth info through the MCP tool's _auth input field OR via
 * environment variables for service-mode operation.
 */
export function resolveAuth(params: {
  apiKey?: string;
  workspaceId?: string;
  agentId?: string;
}): AuthResult {
  const serviceKey = process.env.BRAIN_SERVICE_ROLE_KEY;
  const envApiKey = process.env.BRAIN_API_KEY;

  const apiKey = params.apiKey ?? envApiKey ?? serviceKey;
  if (!apiKey) {
    throw new AuthError(
      "No API key provided. Set BRAIN_API_KEY or BRAIN_SERVICE_ROLE_KEY."
    );
  }

  // Service-role JWT (Supabase): starts with 'eyJ' (base64 JWT header)
  // Service callers are trusted system components — per-request identity
  // overrides are legitimate here (and only here).
  if (apiKey.startsWith("eyJ")) {
    const workspaceId = params.workspaceId ?? process.env.BRAIN_WORKSPACE_ID;
    const agentId = params.agentId ?? process.env.BRAIN_AGENT_ID;
    if (!workspaceId) {
      throw new AuthError(
        "workspace_id is required when using service-role JWT (set BRAIN_WORKSPACE_ID)"
      );
    }
    return {
      rawKey: apiKey,
      ctx: {
        workspaceId,
        principalRole: "service",
        actorId: agentId ?? "service",
        actorKind: "program",
      },
    };
  }

  // Per-agent API key: brain_<workspaceId>_<agentId>_<secret>
  // Identity comes ONLY from the key. Caller-supplied workspace_id/agent_id
  // are ignored here — honoring them would let any agent (or a prompt
  // injection driving one) impersonate another agent and read its private
  // memories. Identity overrides are a service-role privilege.
  if (apiKey.startsWith("brain_")) {
    const parts = apiKey.split("_");
    if (parts.length < 4) {
      throw new AuthError(
        "Malformed BRAIN_API_KEY. Expected: brain_<workspaceId>_<agentId>_<secret>"
      );
    }
    const [, workspaceId, agentId] = parts;
    return {
      rawKey: apiKey,
      ctx: {
        workspaceId,
        principalRole: "agent",
        actorId: agentId,
        actorKind: "agent",
      },
    };
  }

  throw new AuthError(
    "Unrecognised API key format. Expected a Supabase JWT or brain_* key."
  );
}
