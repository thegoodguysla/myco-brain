/**
 * DB-backed glue for the attribution credit line and the session greeting.
 *
 * attribution.ts stays pure (and unit-tested without a database); the two cheap
 * queries that feed it — the bounded memory count and the top item's saved date —
 * live here, shared by brain_recall_memory and brain_context_pack so both behave
 * identically. The session greeting (the "pushed stats" surface) lives here too.
 */
import type pg from "pg";
import {
  resolveAttributionConfig,
  attributionTier,
  buildAttribution,
  type AttributionHint,
} from "./attribution.js";
import { resolveSourceAgents } from "./agent-provenance.js";

// Count at most 101 rows — enough to place the workspace in a decay tier without
// a full count(*) scan on a large table.
export async function boundedMemoryCount(client: pg.PoolClient, workspaceId: string): Promise<number> {
  const r = await client.query(
    `SELECT count(*)::int AS n FROM (
       SELECT 1 FROM hyobjects WHERE workspace_id = $1 AND type_id <> 80 LIMIT 101
     ) s`,
    [workspaceId]
  );
  return r.rows[0]?.n ?? 0;
}

export async function hyobjectSavedAt(client: pg.PoolClient, hyobjectId: string): Promise<string | null> {
  try {
    const r = await client.query(`SELECT created_at FROM hyobjects WHERE hyobject_id = $1`, [hyobjectId]);
    const v = r.rows[0]?.created_at;
    return v ? new Date(v).toISOString() : null;
  } catch {
    return null;
  }
}

// Build the decayed "recalled from your memory" hint for the top returned item.
// Returns null when disabled, when nothing was returned, or once the workspace
// has matured past the decay threshold.
export async function computeAttribution(
  client: pg.PoolClient,
  workspaceId: string,
  top: { hyobject_id: string; name: string | null; agent_id?: string | null } | undefined,
  callerAgentId?: string
): Promise<AttributionHint | null> {
  const cfg = resolveAttributionConfig();
  if (!cfg.enabled || !top) return null;
  const count = await boundedMemoryCount(client, workspaceId);
  const tier = attributionTier(count, cfg.thresholds);
  if (tier === "silent") return null;
  const savedAt = await hyobjectSavedAt(client, top.hyobject_id);

  // Cross-agent credit: when the top memory came from a DIFFERENT agent than the
  // caller, resolve that agent's label so the hint can name it ("…from Cursor's
  // memory"). Same-agent or unknown -> no label, neutral "your memory" credit.
  let sourceAgentLabel: string | null = null;
  if (top.agent_id && top.agent_id !== callerAgentId) {
    const agents = await resolveSourceAgents(client, workspaceId, [top.agent_id]);
    sourceAgentLabel = agents.get(top.agent_id)?.label ?? null;
  }

  return buildAttribution({
    tier,
    topMemoryName: top.name,
    savedAt,
    materiallyUsed: true,
    whyAvailable: true,
    sourceAgentLabel,
  });
}

// "Pushed stats": a one-line greeting surfaced at the start of a session (the
// first brain_context_pack of a server process). Suppressed when there is too
// little to advertise, and disabled with BRAIN_SESSION_GREETING=off. Counts
// ingested documents (the knowledge), not agent-saved memories.
export async function sessionGreeting(
  client: pg.PoolClient,
  workspaceId: string,
  env: Record<string, string | undefined> = process.env
): Promise<string | null> {
  if ((env.BRAIN_SESSION_GREETING ?? "").trim().toLowerCase() === "off") return null;
  const r = await client.query(
    `SELECT count(*)::int AS n FROM hyobjects WHERE workspace_id = $1 AND type_id <> 80`,
    [workspaceId]
  );
  const n = r.rows[0]?.n ?? 0;
  if (n < 5) return null; // nothing worth showing on a near-empty brain
  return `Myco has ${n.toLocaleString()} facts indexed for this workspace.`;
}
