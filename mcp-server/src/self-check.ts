/**
 * Self-check — the structured signals behind the "self-check that talks":
 *   Moment 2 "I need you to approve this" (the gate) and
 *   Moment 3 "I found a problem, here's the fix" (the self-heal).
 *
 * The ENGINE returns these structured objects; the LLM renders them at the volume
 * the current mode calls for (silent/ambient/audit). This module is the pure
 * policy + shapes + plain-text fallback renderers — no I/O, fully unit-testable.
 *
 * DEVIATION FROM THE SURFACING SPEC (intentional): the spec lists brain_save_memory
 * as a gate trigger, but the shipped agent contract defines save_memory as the
 * PRIVATE scratchpad (ungated, never workspace truth). Gating it would contradict
 * that contract, so we gate the actual DURABLE write paths instead — brain_ingest
 * (extracts workspace facts) and brain_propose_fact (proposes a claim), plus any
 * supersession. Private memory and breadcrumbs never gate.
 */
import type { SurfacingMode, ConfidenceBand } from "./surfacing.js";

export type WriteKind = "memory" | "annotation" | "fact" | "ingest";

export interface WriteClassification {
  kind: WriteKind;
  /** Creates/updates durable WORKSPACE truth (vs private scratchpad / breadcrumb). */
  durable: boolean;
  /** Would supersede/retire an existing stored fact. */
  superseding: boolean;
  /** high = externally-sourced or low-confidence justification. */
  risk: "low" | "high";
}

/** Classify a write for gating. memory/annotation are non-durable (never gate). */
export function classifyWrite(
  kind: WriteKind,
  opts?: { superseding?: boolean; highRisk?: boolean }
): WriteClassification {
  const durable = kind === "fact" || kind === "ingest";
  return {
    kind,
    durable,
    superseding: durable && !!opts?.superseding,
    risk: opts?.highRisk ? "high" : "low",
  };
}

/**
 * The gate decision. Mode-aware thresholds from the spec:
 *   - non-durable (save_memory, annotate): never gate.
 *   - Audit: gate every durable write.
 *   - Silent / Ambient: gate durable SUPERSESSIONS and contested HIGH-RISK writes;
 *     auto-approve low-risk first-time durable writes.
 */
export function shouldGate(mode: SurfacingMode, c: WriteClassification): boolean {
  if (!c.durable) return false;
  if (mode === "audit") return true;
  return c.superseding || c.risk === "high";
}

// ---- Moment 2: the approval gate --------------------------------------------
export interface ProposedWrite {
  summary: string;
  source: string;
  confidence_band: ConfidenceBand;
  choices: string[];
}

export function buildProposedWrite(a: {
  summary: string;
  source: string;
  confidenceBand: ConfidenceBand;
}): ProposedWrite {
  return {
    summary: a.summary,
    source: a.source,
    confidence_band: a.confidenceBand,
    choices: ["Save", "Skip", "Always save this kind"],
  };
}

export function renderProposedWrite(p: ProposedWrite): string {
  return [
    `Myco wants to save: "${p.summary}"`,
    `Source: ${p.source}. Confidence: ${p.confidence_band ?? "unknown"}.`,
    p.choices.join(" / "),
  ].join("\n");
}

// ---- Moment 3: the self-heal (contradiction + resolution) -------------------
export interface ContradictionResolution {
  old_claim: string;
  new_claim: string;
  /** What Myco will do by the deterministic rule (newest + highest-provenance wins). */
  resolution: string;
  /** One clause: why this resolution. */
  reason: string;
  choices: string[];
}

export function buildContradictionResolution(a: {
  oldClaim: string;
  newClaim: string;
  keep: "new" | "old";
  reason: string;
}): ContradictionResolution {
  const winner = a.keep === "new" ? a.newClaim : a.oldClaim;
  const loser = a.keep === "new" ? a.oldClaim : a.newClaim;
  return {
    old_claim: a.oldClaim,
    new_claim: a.newClaim,
    resolution: `Trust "${winner}" and retire "${loser}".`,
    reason: a.reason,
    choices: ["Keep new", "Keep old", "Show both"],
  };
}

export function renderContradiction(c: ContradictionResolution): string {
  return [`Heads up: ${c.reason}`, c.resolution, c.choices.join(" / ")].join("\n");
}

// ---- the combined self-check signal the write path returns ------------------
export interface SelfCheck {
  /** If true, the LLM must surface this and wait for confirmation before committing. */
  gated: boolean;
  /** Why (for transparency / logging). */
  reason: string;
  proposed_write?: ProposedWrite;
  contradiction?: ContradictionResolution;
}
