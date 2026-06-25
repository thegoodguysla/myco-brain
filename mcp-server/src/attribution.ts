/**
 * Attribution decay — the "recalled from your memory" credit line, and the rule
 * that keeps it from muddying the experience once a user's own memories pile up.
 *
 * Myco cannot control the host UI; its only lever is what it RETURNS. So recall
 * tools attach a structured `attribution` field (never free text in the result
 * body, or the model parrots "according to my memory..." into commit messages),
 * one instruction-contract clause tells the agent to surface it briefly, and the
 * server decays it as the workspace matures. The governing principle: Myco's
 * loudness is inversely proportional to how much the user's own usage already
 * proves they trust it.
 */

export type AttributionTier = "full" | "conditional" | "silent";

export interface TierThresholds {
  /** <= this many memories: surface a credit line on every recall. */
  fullMax: number;
  /** <= this many: surface only when a memory materially shaped the answer. Above it: silent. */
  conditionalMax: number;
}

export const DEFAULT_THRESHOLDS: TierThresholds = { fullMax: 25, conditionalMax: 100 };

/**
 * Resolve on/off + thresholds from env.
 *   BRAIN_ATTRIBUTION=off            disable the credit line entirely
 *   BRAIN_ATTRIBUTION_DECAY="5,20"   override fullMax,conditionalMax
 */
export function resolveAttributionConfig(
  env: Record<string, string | undefined> = process.env
): { enabled: boolean; thresholds: TierThresholds } {
  if ((env.BRAIN_ATTRIBUTION ?? "").trim().toLowerCase() === "off") {
    return { enabled: false, thresholds: DEFAULT_THRESHOLDS };
  }
  const raw = (env.BRAIN_ATTRIBUTION_DECAY ?? "").trim();
  if (raw) {
    const [a, b] = raw.split(/[,:]/).map((s) => parseInt(s, 10));
    if (Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= a) {
      return { enabled: true, thresholds: { fullMax: a, conditionalMax: b } };
    }
  }
  return { enabled: true, thresholds: DEFAULT_THRESHOLDS };
}

/**
 * Decay axis: the workspace's own memory count — a cheap, no-migration proxy for
 * "how much has this user invested / how convinced are they". A precise
 * recall-event counter is the future upgrade; the tiers stay the same.
 */
export function attributionTier(
  workspaceMemoryCount: number,
  t: TierThresholds = DEFAULT_THRESHOLDS
): AttributionTier {
  if (workspaceMemoryCount <= t.fullMax) return "full";
  if (workspaceMemoryCount <= t.conditionalMax) return "conditional";
  return "silent";
}

export interface AttributionHint {
  recalled_from_memory: true;
  /** The one-line credit the agent should briefly surface. */
  surface_hint: string;
  /** brain_why can show the full provenance trail on demand. */
  why_available: boolean;
  saved_at: string | null;
  /** The agent the top memory came from, when it differs from the caller
   *  ("Cursor", "Claude Code"). Null for same-agent or unknown provenance. */
  source_agent?: string | null;
}

export interface AttributionInput {
  tier: AttributionTier;
  topMemoryName: string | null;
  /** ISO timestamp of the top recalled memory, if known. */
  savedAt?: string | null;
  /** Did we actually return a memory that shaped the answer? */
  materiallyUsed: boolean;
  whyAvailable?: boolean;
  /** Label of the agent that saved the top memory, when it is a DIFFERENT agent
   *  than the caller — drives the cross-agent "came from Cursor" credit. */
  sourceAgentLabel?: string | null;
}

/**
 * Build the hint, or null when it should stay silent. Centralizes the decay
 * policy so brain_recall_memory and brain_context_pack behave identically.
 */
export function buildAttribution(input: AttributionInput): AttributionHint | null {
  if (input.tier === "silent") return null;
  if (!input.topMemoryName) return null;
  if (input.tier === "conditional" && !input.materiallyUsed) return null;
  const when = formatSavedAt(input.savedAt);
  const name = input.topMemoryName.trim();
  if (!name) return null;
  const from = input.sourceAgentLabel?.trim();
  // When the top memory came from a different agent, name it — that's the
  // cross-agent moment. Otherwise keep the neutral "your memory" credit.
  const whose = from ? `${from}'s memory` : "your memory";
  const surface = `Recalled from ${whose}${when ? ` (saved ${when})` : ""}: ${name}`;
  return {
    recalled_from_memory: true,
    surface_hint: surface,
    why_available: input.whyAvailable ?? true,
    saved_at: input.savedAt ?? null,
    source_agent: from || null,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Jun 9" style; tolerant of bad input (returns null). */
export function formatSavedAt(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * The one clause added to the agent usage-contract so the model knows what to do
 * with the field — and, crucially, what NOT to do with it.
 */
export const ATTRIBUTION_CONTRACT_CLAUSE =
  `- When a recall result includes an "attribution" object, surface its surface_hint as a brief one-line credit (e.g. "Recalled from your memory: ...") so the user sees the memory working. Never copy this bookkeeping into user-facing deliverables (commit messages, PRs, code, docs). The field decays to null on its own as the workspace matures; when it is absent, say nothing about memory provenance unless the user asks.`;
