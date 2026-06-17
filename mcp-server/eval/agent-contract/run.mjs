#!/usr/bin/env node
/**
 * Agent-contract eval — measures whether an agent, given Myco's runtime contract
 * and the real brain_* tool descriptions, routes to the RIGHT tool for each
 * scenario. This is how we turn "the instructions feel good" into a number, and
 * iterate the contract until adherence clears the bar.
 *
 * For each scenario it calls the Anthropic Messages API with:
 *   - system = the single-sourced RUNTIME_CONTRACT (dist/agent-instructions.js)
 *   - tools  = the brain_* tool schemas (descriptions drive selection)
 *   - user   = the scenario "situation"
 * then scores the FIRST tool the model reaches for against expected_tool, and
 * flags the dominant failure mode (wrongly reaching for brain_save_memory).
 *
 * Run:  ANTHROPIC_API_KEY=... npm run eval:contract
 *       (skips cleanly with a message when the key is absent, like the DB tests)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.log("[skip] agent-contract eval — ANTHROPIC_API_KEY is not set.");
  console.log("        Set it and re-run to score tool-routing adherence.");
  process.exit(0);
}

const MODEL = process.env.BRAIN_EVAL_MODEL || "claude-sonnet-4-6";
const here = dirname(fileURLToPath(import.meta.url));
const { RUNTIME_CONTRACT } = await import("../../dist/agent-instructions.js");
const { default: Anthropic } = await import("@anthropic-ai/sdk");
const scenarios = JSON.parse(readFileSync(join(here, "scenarios.json"), "utf8")).scenarios;

// The brain_* tools, with the routing-critical descriptions mirrored from
// src/index.ts. Minimal input schemas: the eval measures tool CHOICE, not args.
const obj = (props = {}) => ({ type: "object", properties: props });
const TOOLS = [
  { name: "brain_context_pack", description: "Primary read. Assemble relevant prior decisions, entities, people, and ingested documents for a task topic. Call FIRST on any task.", input_schema: obj({ query: { type: "string" } }) },
  { name: "brain_search", description: "Full-text / semantic search across ingested workspace sources.", input_schema: obj({ query: { type: "string" } }) },
  { name: "brain_why", description: "Provenance for a fact: its source chain, current confidence, and whether it is contested. Use for 'why' and 'since when'.", input_schema: obj({ subject: { type: "string" } }) },
  { name: "brain_neighbors", description: "Walk the knowledge graph from an entity.", input_schema: obj({ entity: { type: "string" } }) },
  { name: "brain_get_related", description: "Relational context and the people/entities around a topic, with provenance.", input_schema: obj({ query: { type: "string" } }) },
  { name: "brain_recall_memory", description: "Recall YOUR OWN private saved notes only (not workspace knowledge).", input_schema: obj({ query: { type: "string" } }) },
  { name: "brain_stats", description: "Workspace memory-health snapshot.", input_schema: obj() },
  { name: "brain_ingest", description: "The default write path. Hand the engine a source (a document, transcript, thread, or decision record) and it extracts entities and relations with a source and a confidence score each, runs contradiction-and-supersession, and folds them into the workspace graph. The primary way truth enters Myco; prefer it over asserting conclusions, and feed two or three independent sources when a fact matters so confidence compounds.", input_schema: obj({ mode: { type: "string", enum: ["text", "url", "file"] }, text: { type: "string" }, url: { type: "string" } }) },
  { name: "brain_propose_fact", description: "Submit a structured claim (subject, predicate, object) when you believe something is true but have no source to ingest. It enters a gated review queue as a candidate and is promoted when a reviewer approves it or a later ingested source corroborates it. Use brain_ingest whenever a source exists.", input_schema: obj({ kind: { type: "string" }, canonical_name: { type: "string" }, predicate: { type: "string" } }) },
  { name: "brain_save_memory", description: "Your PRIVATE scratchpad, not workspace truth. Ungated, scoped to YOUR agent only, confidence hardcoded 1.0, nothing extracted, no provenance, recalled only by you. Use strictly for private working notes within a session, never for facts the workspace or other agents should trust or cite.", input_schema: obj({ content: { type: "string" } }) },
  { name: "brain_annotate", description: "Attach a lightweight note to the current session for continuity. Not extracted, not adjudicated, not durable workspace truth.", input_schema: obj({ kind: { type: "string" }, content: { type: "string" } }) },
];

const client = new Anthropic({ apiKey: KEY });

async function firstToolFor(situation) {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: RUNTIME_CONTRACT,
    tools: TOOLS,
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: situation }],
  });
  const tool = res.content.find((b) => b.type === "tool_use");
  return tool ? tool.name : "none";
}

// Limited-concurrency map.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          out[idx] = await fn(items[idx], idx);
        } catch (err) {
          out[idx] = { error: String(err?.message || err) };
        }
      }
    })
  );
  return out;
}

console.log(`\nAgent-contract eval — model ${MODEL}, ${scenarios.length} scenarios\n`);

const results = await mapLimit(scenarios, 4, async (s) => {
  const got = await firstToolFor(s.situation);
  const correct = got === s.expected_tool;
  // The dominant failure mode: reaching for the private scratchpad when the fact
  // belongs in the program (anything but an intended save_memory scenario).
  const antiSave = got === "brain_save_memory" && s.expected_tool !== "brain_save_memory";
  const antiNone = s.expected_tool === "none" && got !== "none";
  return { id: s.id, category: s.category, expected: s.expected_tool, got, correct, anti: antiSave || antiNone };
});

let correct = 0, anti = 0;
const byCat = {};
for (const r of results) {
  if (r.error) continue;
  byCat[r.category] ??= { n: 0, ok: 0 };
  byCat[r.category].n++;
  if (r.correct) { correct++; byCat[r.category].ok++; }
  if (r.anti) anti++;
  const mark = r.correct ? "\x1b[32mok  \x1b[0m" : r.anti ? "\x1b[31mANTI\x1b[0m" : "\x1b[33mmiss\x1b[0m";
  console.log(`  ${mark} ${r.id.padEnd(34)} expected ${r.expected.padEnd(20)} got ${r.got}`);
}
const n = results.filter((r) => !r.error).length;
const adherence = n ? Math.round((correct / n) * 1000) / 10 : 0;
const antiRate = n ? Math.round((anti / n) * 1000) / 10 : 0;

console.log(`\n  Adherence: ${correct}/${n} = ${adherence}%   |   save_memory-misuse (anti): ${anti}/${n} = ${antiRate}%`);
console.log("  By category:");
for (const [cat, v] of Object.entries(byCat)) {
  console.log(`    ${cat.padEnd(16)} ${v.ok}/${v.n}`);
}
const BAR = Number(process.env.BRAIN_EVAL_BAR || 90);
console.log("");
if (adherence >= BAR) {
  console.log(`  PASS — adherence ${adherence}% >= ${BAR}% bar.\n`);
  process.exit(0);
} else {
  console.log(`  BELOW BAR — adherence ${adherence}% < ${BAR}%. Iterate the contract / tool descriptions and re-run.\n`);
  process.exit(1);
}
