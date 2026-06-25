/**
 * Per-client agent identity — give each connected client (Claude Code, Cursor,
 * Codex, …) its OWN brain agent, so memory provenance is accurate per tool: a
 * memory written from Cursor is stamped Cursor and, recalled from Claude, is
 * credited to Cursor. Workspace-shared memories still cross between agents (the
 * default sharing is workspace), so separate identities add provenance WITHOUT
 * siloing recall.
 *
 * Pure identity derivation (deterministic, so re-running the installer reuses the
 * same agent) + one idempotent DB mint that satisfies the
 * hyobjects.agent_id -> agents FK before that client can write.
 */
import crypto from "node:crypto";
import type pg from "pg";
import { parseBrainApiKey } from "./auth.js";

export interface ClientAgentIdentity {
  platform: string;
  display_name: string;
}

// agents.platform is CHECK-constrained to {paperclip,claude-code,cowork,other},
// so only Claude Code maps to a dedicated platform; every other client buckets
// as 'other' and carries its real name in display_name (where provenance reads
// the label from — see agent-provenance.sourceAgentLabel).
const CLIENT_IDENTITY: Record<string, ClientAgentIdentity> = {
  "claude-code": { platform: "claude-code", display_name: "Claude Code" },
  "claude-desktop": { platform: "other", display_name: "Claude Desktop" },
  cursor: { platform: "other", display_name: "Cursor" },
  windsurf: { platform: "other", display_name: "Windsurf" },
  codex: { platform: "other", display_name: "Codex" },
  zed: { platform: "other", display_name: "Zed" },
  continue: { platform: "other", display_name: "Continue" },
  cline: { platform: "other", display_name: "Cline" },
};

export function clientIdentity(clientKey: string): ClientAgentIdentity {
  return CLIENT_IDENTITY[clientKey] ?? { platform: "other", display_name: clientKey };
}

// Fixed namespace for Myco client-agent ids (any constant UUID works).
const MYCO_AGENT_NS = "a9b8c7d6-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

/**
 * Deterministic agent_id for a (workspace, client) pair — RFC-4122 v5 (sha1),
 * so re-running the installer reuses the same agent instead of spawning a
 * duplicate each time.
 */
export function clientAgentId(workspaceId: string, clientKey: string): string {
  return uuidv5(`${workspaceId}:${clientKey}`, MYCO_AGENT_NS);
}

/**
 * Build a per-client API key from a base brain_ key by swapping in the client's
 * agent id (workspace + secret are preserved). Throws if the base key is not a
 * brain_<ws>_<agent>_<secret> key — service-role JWTs have no per-agent identity.
 */
export function clientApiKey(baseApiKey: string, agentId: string): string {
  const { workspaceId, secret } = parseBrainApiKey(baseApiKey);
  return `brain_${workspaceId}_${agentId}_${secret}`;
}

/** True when a base key can carry a per-client agent identity (brain_ keys only). */
export function supportsPerClientAgent(baseApiKey: string): boolean {
  return baseApiKey.startsWith("brain_");
}

export interface ProvisionedClientAgent {
  agentId: string;
  apiKey: string;
  identity: ClientAgentIdentity;
}

/**
 * Idempotently create the client's agent row (so the hyobjects.agent_id FK is
 * satisfied) and return its per-client API key. Re-runs reuse the same agent.
 */
export async function provisionClientAgent(
  client: pg.PoolClient,
  baseApiKey: string,
  clientKey: string
): Promise<ProvisionedClientAgent> {
  const { workspaceId } = parseBrainApiKey(baseApiKey);
  const identity = clientIdentity(clientKey);
  const agentId = clientAgentId(workspaceId, clientKey);
  await client.query(
    `INSERT INTO agents (agent_id, workspace_id, platform, display_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (agent_id) DO UPDATE
        SET platform = EXCLUDED.platform, display_name = EXCLUDED.display_name`,
    [agentId, workspaceId, identity.platform, identity.display_name]
  );
  return { agentId, apiKey: clientApiKey(baseApiKey, agentId), identity };
}

// ── RFC-4122 v5 (deterministic, namespace + name via sha1) ───────────────────
function uuidv5(name: string, namespace: string): string {
  const nsBytes = uuidToBytes(namespace);
  const hash = crypto.createHash("sha1").update(Buffer.concat([nsBytes, Buffer.from(name, "utf8")])).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC-4122 variant
  return bytesToUuid(bytes);
}

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  return Buffer.from(hex, "hex");
}

function bytesToUuid(b: Buffer): string {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
