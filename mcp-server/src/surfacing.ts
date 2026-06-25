/**
 * Surfacing — the compact, token-cheap signal layer (the "surfacing envelope").
 *
 * Myco runs silent by default. The envelope is metadata the LLM READS to decide
 * whether (and how loudly) to surface that memory engaged — it is NOT echoed into
 * the visible response unless the mode calls for it. See the surfacing experience
 * spec (Silent / Ambient / Audit; the self-check that talks).
 *
 * Claims integrity: every number here is read from the brain (fact count, the
 * stored-confidence band, source types), never estimated by the LLM. The engine
 * renders the exact heartbeat string so the LLM surfaces the brain's numbers
 * verbatim rather than guessing.
 */

export type SurfacingMode = "silent" | "ambient" | "audit";

const MODES: readonly SurfacingMode[] = ["silent", "ambient", "audit"];

/** Default mode is Silent: ~0 added tokens, fully in the background. */
export const DEFAULT_MODE: SurfacingMode = "silent";

/**
 * Resolve the active surfacing mode. Precedence:
 *   explicit override (e.g. a persisted workspace preference the caller passes)
 *   > BRAIN_MODE env > Silent.
 * The [B2] preference store passes the persisted workspace mode in via `override`.
 */
/** Validate a string against the known modes; null if not a valid mode. */
export function coerceMode(v: string | null | undefined): SurfacingMode | null {
  const s = (v ?? "").trim().toLowerCase();
  return (MODES as readonly string[]).includes(s) ? (s as SurfacingMode) : null;
}

export function resolveMode(override?: string | null): SurfacingMode {
  return coerceMode(override) ?? coerceMode(process.env.BRAIN_MODE) ?? DEFAULT_MODE;
}

export type ConfidenceBand = "high" | "medium" | "low" | null;

/** Map a stored mean confidence (0..1) to a coarse band. Null when unknown. */
export function confidenceBand(mean: number | null | undefined): ConfidenceBand {
  if (mean === null || mean === undefined || Number.isNaN(mean)) return null;
  if (mean >= 0.8) return "high";
  if (mean >= 0.5) return "medium";
  return "low";
}

export interface SurfacingEnvelope {
  /** Active visibility mode (silent | ambient | audit). */
  mode: SurfacingMode;
  /** Facts (chunks) that materially shaped the answer. From the brain. */
  fact_count: number;
  /** Coarse band of the stored confidence of those facts. From the brain. */
  confidence_band: ConfidenceBand;
  /** Count of distinct source types behind the facts. */
  source_type_count: number;
  /** Per-source-type counts (type_id -> n), as recorded by the brain. */
  source_types: Record<number, number>;
  /**
   * The exact one-line heartbeat the LLM may surface in ambient/audit, or null
   * when nothing should be shown (silent mode, or zero facts). ~15 tokens max.
   * Provided by the engine so the surfaced numbers are the brain's, not estimated.
   * The LLM still dedupes per session — it should not repeat the same fact set.
   */
  heartbeat: string | null;
}

export interface BuildEnvelopeArgs {
  mode: SurfacingMode;
  factCount: number;
  confidenceMean: number | null | undefined;
  sourceTypes: Record<number, number>;
}

/** Build the compact surfacing envelope from data the brain already computed. */
export function buildSurfacingEnvelope(args: BuildEnvelopeArgs): SurfacingEnvelope {
  const source_types = args.sourceTypes ?? {};
  const env: SurfacingEnvelope = {
    mode: args.mode,
    fact_count: Math.max(0, args.factCount | 0),
    confidence_band: confidenceBand(args.confidenceMean),
    source_type_count: Object.keys(source_types).length,
    source_types,
    heartbeat: null,
  };
  env.heartbeat = renderHeartbeat(env);
  return env;
}

/**
 * The Moment-1 heartbeat line.
 *   - Silent  -> null (the token contract: ~0 added tokens).
 *   - Ambient / Audit with >= 1 fact -> one compact <=15-token line.
 *   - Zero facts -> null.
 */
export function renderHeartbeat(
  env: Pick<SurfacingEnvelope, "mode" | "fact_count">
): string | null {
  if (env.mode === "silent") return null;
  if (env.fact_count <= 0) return null;
  const noun = env.fact_count === 1 ? "fact" : "facts";
  return `Myco: ${env.fact_count} ${noun} used. Ask "why" to see sources.`;
}
