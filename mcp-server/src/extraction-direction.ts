/**
 * Gold-fixture relationship-direction scoring.
 *
 * Relationships are directed (subject → object). Small local models often
 * extract the right two entities but in the WRONG order ("Beta acquired Acme"),
 * which silently corrupts the graph. This module provides:
 *   - GOLD_RELATIONS: clearly-directed facts drawn from the demo corpus.
 *   - scoreDirection(): given a model's extracted relations, classify each gold
 *     fact as "correct" (right direction), "reversed" (entities swapped), or
 *     "missing" (relation not found).
 *
 * The pure logic here is unit-tested (CI-safe). The live model error rate is
 * measured by test/extraction-direction-check.mjs against a configured provider.
 */
import type { ExtractedRelation } from "./extraction-worker.lib.js";

export type DirectionVerdict = "correct" | "reversed" | "missing";

export interface GoldRelation {
  /** Sentence handed to the extractor. */
  text: string;
  /** Expected directed endpoints. */
  subject: string;
  object: string;
  /** Acceptable predicate stems (substring match) for predicate accuracy. */
  predicates: string[];
}

/**
 * Clearly-directed facts grounded in examples/demo-corpus. Each reversal is
 * obviously wrong (e.g. "Lumen reports to Devin"), so a wrong verdict really
 * does mean the model got the direction wrong.
 */
export const GOLD_RELATIONS: GoldRelation[] = [
  { text: "Mara Quinn founded the agency Lumen in 2024.",
    subject: "Mara Quinn", object: "Lumen", predicates: ["found", "start", "creat"] },
  { text: "Devin Osei reports to Mara Quinn on strategy.",
    subject: "Devin Osei", object: "Mara Quinn", predicates: ["report"] },
  { text: "Northwind Coffee hired Lumen to lead a brand refresh.",
    subject: "Northwind Coffee", object: "Lumen", predicates: ["hire", "engag", "retain"] },
  { text: "Mara Quinn owns the Northwind Coffee account.",
    subject: "Mara Quinn", object: "Northwind Coffee", predicates: ["own", "manage", "lead"] },
  { text: "Priya Raman manages paid acquisition for Northwind Coffee.",
    subject: "Priya Raman", object: "Northwind Coffee", predicates: ["manage", "run", "own", "lead"] },
  { text: "Sasha Lind works for Lumen.",
    subject: "Sasha Lind", object: "Lumen", predicates: ["work", "employ", "part of"] },
  { text: "Reuben Cole works for Lumen.",
    subject: "Reuben Cole", object: "Lumen", predicates: ["work", "employ", "build", "part of"] },
  { text: "Lumen serves the client Northwind Coffee.",
    subject: "Lumen", object: "Northwind Coffee", predicates: ["serv", "support", "work"] },
  { text: "Devin Osei writes launch copy for Northwind Coffee.",
    subject: "Devin Osei", object: "Northwind Coffee", predicates: ["writ", "draft", "creat", "work"] },
  { text: "Tom Becker builds brand systems for Northwind Coffee.",
    subject: "Tom Becker", object: "Northwind Coffee", predicates: ["build", "design", "creat", "work"] },
  // Passive voice — the classic direction trap: the surface word order is the
  // reverse of the logical subject→object, so a model that copies word order
  // gets these backwards.
  { text: "Lumen was hired by Northwind Coffee for the rebrand.",
    subject: "Northwind Coffee", object: "Lumen", predicates: ["hire", "engag", "retain"] },
  { text: "Lumen was founded by Mara Quinn.",
    subject: "Mara Quinn", object: "Lumen", predicates: ["found", "start", "creat"] },
  { text: "The Northwind Coffee account is managed by Priya Raman.",
    subject: "Priya Raman", object: "Northwind Coffee", predicates: ["manage", "run", "own", "lead"] },
  { text: "Devin Osei was hired by Lumen as its lead copywriter.",
    subject: "Lumen", object: "Devin Osei", predicates: ["hire", "employ"] },
];

const STOP_TOKENS = new Set([
  "the", "agency", "client", "account", "inc", "llc", "co", "company", "corp",
]);

function tokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOP_TOKENS.has(t))
  );
}

/**
 * Fuzzy entity equality: the two names share a distinctive token (length >= 3,
 * not a stop word). "Mara Quinn" ~ "Mara"; "Northwind Coffee" ~ "Northwind".
 */
export function entityMatches(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  for (const t of ta) if (tb.has(t)) return true;
  return false;
}

export function predicateMatches(predicate: string, gold: GoldRelation): boolean {
  const p = predicate.toLowerCase();
  return gold.predicates.some((stem) => p.includes(stem));
}

/**
 * Classify how the model handled a single gold relation. Prefers "correct"
 * over "reversed" when both somehow match.
 */
export function scoreDirection(
  gold: GoldRelation,
  relations: ExtractedRelation[]
): DirectionVerdict {
  for (const r of relations) {
    if (entityMatches(r.subject, gold.subject) && entityMatches(r.object, gold.object)) {
      return "correct";
    }
  }
  for (const r of relations) {
    if (entityMatches(r.subject, gold.object) && entityMatches(r.object, gold.subject)) {
      return "reversed";
    }
  }
  return "missing";
}

export interface DirectionScore {
  total: number;
  correct: number;
  reversed: number;
  missing: number;
  /** correct / total — fraction with the right direction. */
  directedAccuracy: number;
  /** (reversed + missing) / total. */
  errorRate: number;
  /** Of the relations that were FOUND, fraction in the right direction. */
  directionalPrecision: number;
}

/** Aggregate per-gold verdicts into a score. */
export function summarize(verdicts: DirectionVerdict[]): DirectionScore {
  const total = verdicts.length;
  const correct = verdicts.filter((v) => v === "correct").length;
  const reversed = verdicts.filter((v) => v === "reversed").length;
  const missing = verdicts.filter((v) => v === "missing").length;
  const found = correct + reversed;
  return {
    total,
    correct,
    reversed,
    missing,
    directedAccuracy: total ? correct / total : 0,
    errorRate: total ? (reversed + missing) / total : 0,
    directionalPrecision: found ? correct / found : 0,
  };
}
