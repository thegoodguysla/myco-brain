/**
 * Memory provenance by source agent — "this came from Cursor".
 *
 * Every hyobject already records the agent that created it (hyobjects.agent_id),
 * and the agents table carries that agent's platform + display_name. This module
 * is the thin join that turns those ids into a human label and surfaces it on
 * read results, so an agent (and the user) can SEE which client a memory came
 * from — the cross-agent magic: write in Cursor, recall in Claude, and the recall
 * says it came from Cursor.
 *
 * The label formatter is pure (unit-tested); the two cheap queries take an
 * injected/real PoolClient and are exercised against the test DB.
 */
import type pg from "pg";

export interface SourceAgent {
  agent_id: string;
  platform: string | null;
  display_name: string | null;
  /** Human label ("Claude Code", "Cursor", …), or null when there's nothing useful. */
  label: string | null;
}

// Known platform keys (as the installer stamps them) -> friendly names. Anything
// else falls back to a title-cased platform, and the generic "other"/empty
// placeholder yields no label (so we never surface a meaningless "Other").
const PLATFORM_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor",
  windsurf: "Windsurf",
  codex: "Codex",
  zed: "Zed",
  continue: "Continue",
  cline: "Cline",
};

/**
 * Best human label for a source agent. Prefers the explicit display_name the
 * installer set; else maps a known platform key; else title-cases an unknown
 * platform; returns null for the generic "other"/empty placeholder.
 */
export function sourceAgentLabel(
  agent: { platform?: string | null; display_name?: string | null } | null | undefined
): string | null {
  if (!agent) return null;
  const dn = agent.display_name?.trim();
  // The generic seeded placeholder is not worth surfacing — treat it as absent.
  const name = dn && dn.toLowerCase() !== "default local agent" ? dn : null;
  if (name) return name;
  const platform = agent.platform?.trim().toLowerCase();
  if (!platform || platform === "other") return null;
  if (PLATFORM_LABELS[platform]) return PLATFORM_LABELS[platform];
  return platform.replace(/(^|[-_\s])([a-z])/g, (_, sep, ch) => (sep ? " " : "") + ch.toUpperCase());
}

/** Resolve {platform, display_name, label} for a set of agent ids in a workspace. */
export async function resolveSourceAgents(
  client: pg.PoolClient,
  workspaceId: string,
  agentIds: Array<string | null | undefined>
): Promise<Map<string, SourceAgent>> {
  const ids = Array.from(new Set(agentIds.filter((id): id is string => !!id)));
  const out = new Map<string, SourceAgent>();
  if (ids.length === 0) return out;
  // resolveSourceAgents runs INSIDE recall's transaction — a thrown query would
  // poison it. to_regclass returns null (no error) when the table is absent on an
  // older schema, so we skip cleanly instead of aborting the surrounding txn.
  const present = await client.query(`SELECT to_regclass('public.agents') IS NOT NULL AS ok`);
  if (!present.rows[0]?.ok) return out;
  const res = await client.query(
    `SELECT agent_id, platform, display_name
       FROM agents
      WHERE workspace_id = $1 AND agent_id = ANY($2::text[])`,
    [workspaceId, ids]
  );
  const rows = res.rows as Array<{ agent_id: string; platform: string | null; display_name: string | null }>;
  for (const r of rows) {
    out.set(r.agent_id, {
      agent_id: r.agent_id,
      platform: r.platform,
      display_name: r.display_name,
      label: sourceAgentLabel(r),
    });
  }
  return out;
}

/** Attach a `source_agent` field to each row carrying an `agent_id`. */
export function attachSourceAgent<T extends { agent_id: string | null }>(
  rows: T[],
  lookup: Map<string, SourceAgent>
): Array<T & { source_agent: SourceAgent | null }> {
  return rows.map((r) => ({
    ...r,
    source_agent: r.agent_id ? lookup.get(r.agent_id) ?? null : null,
  }));
}

export interface AgentBreakdownEntry {
  agent_id: string;
  platform: string | null;
  display_name: string | null;
  label: string | null;
  memories: number;
}

/**
 * Per-agent memory counts for a workspace, most-active first — the "42 memories:
 * 30 Claude Code, 8 Cursor, 4 Codex" stat that makes cross-agent compounding
 * visible. Counts recallable documents (type_id <> 80 excludes audit/action rows).
 */
export async function agentMemoryBreakdown(
  client: pg.PoolClient,
  workspaceId: string
): Promise<AgentBreakdownEntry[]> {
  try {
    const res = await client.query(
      `SELECT h.agent_id, a.platform, a.display_name, count(*)::int AS memories
         FROM hyobjects h
         LEFT JOIN agents a ON a.agent_id = h.agent_id AND a.workspace_id = h.workspace_id
        WHERE h.workspace_id = $1 AND h.type_id <> 80 AND h.agent_id IS NOT NULL
        GROUP BY h.agent_id, a.platform, a.display_name
        ORDER BY memories DESC, h.agent_id`,
      [workspaceId]
    );
    return res.rows.map((r) => ({
      agent_id: r.agent_id,
      platform: r.platform,
      display_name: r.display_name,
      label: sourceAgentLabel(r),
      memories: Number(r.memories),
    }));
  } catch {
    return [];
  }
}

/** One-line "N memories: 30 Claude Code, 8 Cursor" summary, or null if <2 agents. */
export function breakdownSummary(entries: AgentBreakdownEntry[]): string | null {
  const named = entries.filter((e) => e.memories > 0);
  if (named.length < 2) return null;
  const total = named.reduce((s, e) => s + e.memories, 0);
  const parts = named
    .slice(0, 5)
    .map((e) => `${e.memories} ${e.label ?? shortId(e.agent_id)}`);
  return `${total} memories: ${parts.join(", ")}`;
}

function shortId(id: string): string {
  return id.slice(0, 8) + "…";
}
