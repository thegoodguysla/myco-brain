#!/usr/bin/env node
/**
 * Relationship-direction regression check — GATED.
 *
 * Runs the gold-fixture sentences (examples/demo-corpus facts) through the
 * configured extraction provider and measures how often the model gets the
 * subject→object DIRECTION right. Reports a per-model error rate and fails when
 * directed accuracy drops below a threshold.
 *
 * Provider selection mirrors the extraction worker:
 *   BRAIN_EXTRACTION_PROVIDER (anthropic|ollama) wins; else Anthropic when a key
 *   is set; else Ollama when a base URL (or the localhost default) is reachable.
 * Skips (exit 0) only when no real model is configured.
 *
 * Threshold: BRAIN_DIRECTION_MIN_ACCURACY (default 0.7).
 * Needs the server built (dist/). No database required.
 */
import Anthropic from "@anthropic-ai/sdk";
import { extract } from "../dist/extraction.js";
import {
  GOLD_RELATIONS,
  scoreDirection,
  predicateMatches,
  entityMatches,
  summarize,
} from "../dist/extraction-direction.js";

const anthropicKey = process.env.BRAIN_ANTHROPIC_API_KEY;
const ollamaBase = (process.env.BRAIN_OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
const explicit = (process.env.BRAIN_EXTRACTION_PROVIDER ?? "").toLowerCase();
const provider = explicit || (anthropicKey ? "anthropic" : ollamaBase ? "ollama" : "fake");

if (provider === "fake" || (provider === "anthropic" && !anthropicKey)) {
  console.log(`[skip] direction check — no real extraction model configured (provider=${provider}).`);
  process.exit(0);
}

const config =
  provider === "anthropic"
    ? {
        provider: "anthropic",
        anthropic: new Anthropic({ apiKey: anthropicKey }),
        anthropicModel: process.env.BRAIN_EXTRACTION_MODEL ?? "claude-sonnet-4-20250514",
      }
    : {
        provider: "ollama",
        ollamaBaseUrl: ollamaBase,
        ollamaModel: process.env.BRAIN_OLLAMA_MODEL ?? "llama3.2:3b",
      };

const label =
  provider === "anthropic" ? `anthropic:${config.anthropicModel}` : `ollama:${config.ollamaModel}`;
const minAccuracy = Number(process.env.BRAIN_DIRECTION_MIN_ACCURACY ?? "0.8");

console.log(`Relationship-direction check — model ${label}, ${GOLD_RELATIONS.length} gold facts\n`);

const verdicts = [];
let predicateHits = 0;
// Endpoint completeness: of the relations the model emitted, how many have
// BOTH endpoints listed in entities (post-recovery)? Incomplete relations are
// silently dropped by the worker's anti-hallucination guard, so this is the
// edge-survival rate for the knowledge graph.
let relTotal = 0;
let relComplete = 0;
for (const gold of GOLD_RELATIONS) {
  let out;
  try {
    out = await extract(gold.text, config);
  } catch (err) {
    console.error(`  ERR   "${gold.text}" — ${err?.message ?? err}`);
    verdicts.push("missing");
    continue;
  }
  const verdict = scoreDirection(gold, out.relations);
  verdicts.push(verdict);
  // Predicate accuracy: of the relations we FOUND (either direction), did the
  // predicate land in the gold family? Find the actual matched relation.
  const found = out.relations.find(
    (r) =>
      (entityMatches(r.subject, gold.subject) && entityMatches(r.object, gold.object)) ||
      (entityMatches(r.subject, gold.object) && entityMatches(r.object, gold.subject))
  );
  if (found && predicateMatches(found.predicate, gold)) predicateHits++;
  const known = new Set(
    out.entities.flatMap((e) => [
      e.name.toLowerCase(),
      ...(e.aliases ?? []).map((a) => a.toLowerCase()),
    ])
  );
  for (const r of out.relations) {
    relTotal++;
    if (known.has(r.subject.toLowerCase()) && known.has(r.object.toLowerCase())) relComplete++;
  }
  const mark = verdict === "correct" ? "ok  " : verdict === "reversed" ? "REV " : "MISS";
  console.log(
    `  ${mark}  ${gold.subject} →(${gold.predicates[0]})→ ${gold.object}` +
      `   [extracted ${out.relations.length} rel(s)]`
  );
}

const s = summarize(verdicts);
console.log(
  `\nDirected accuracy: ${(s.directedAccuracy * 100).toFixed(0)}% ` +
    `(${s.correct}/${s.total})  ·  reversed: ${s.reversed}  ·  missing: ${s.missing}` +
    `\nError rate:        ${(s.errorRate * 100).toFixed(0)}%` +
    `\nDirectional precision (of found): ${(s.directionalPrecision * 100).toFixed(0)}%` +
    `\nPredicate accuracy (of found):    ${
      s.correct + s.reversed ? Math.round((predicateHits / (s.correct + s.reversed)) * 100) : 0
    }%`
);

const completeness = relTotal > 0 ? relComplete / relTotal : 1;
// llama3.2:3b measures 79% post-recovery (was 0% before endpoint recovery);
// the remaining gap is junk phrase-objects that SHOULD be rejected.
const minCompleteness = Number(process.env.BRAIN_ENDPOINT_MIN_COMPLETENESS ?? "0.75");
console.log(
  `Endpoint completeness (edge survival): ${(completeness * 100).toFixed(0)}% ` +
    `(${relComplete}/${relTotal} relations have both endpoints in entities)`
);

const pass = s.directedAccuracy >= minAccuracy && completeness >= minCompleteness;
console.log(
  `\n=== ${pass ? "PASS" : "FAIL"} (direction) — ${label}, ` +
    `directed accuracy ${(s.directedAccuracy * 100).toFixed(0)}% vs threshold ${(minAccuracy * 100).toFixed(0)}%, ` +
    `endpoint completeness ${(completeness * 100).toFixed(0)}% vs ${(minCompleteness * 100).toFixed(0)}% ===`
);
process.exit(pass ? 0 : 1);
