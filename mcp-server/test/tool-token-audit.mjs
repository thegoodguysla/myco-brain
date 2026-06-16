#!/usr/bin/env node
/**
 * Tool-schema token audit (WO-3). Measures what the 11 brain_* tool
 * definitions cost in an agent's context window — the ListTools payload the
 * model sees on every connection — and guards it against silent growth.
 *
 * Token count uses gpt-4o's tokenizer (o200k_base); the same text costs a
 * similar order on Claude. Deterministic, no DB, no network.
 *
 * Exit non-zero if the total exceeds BUDGET_TOKENS so a future schema edit
 * can't quietly bloat every agent's context. Run: npm run audit:tokens
 */
import { countTokens } from "gpt-tokenizer/model/gpt-4o";
import { TOOLS } from "../dist/index.js";

// Profile loading kicks in above this; also the regression ceiling.
const BUDGET_TOKENS = 8000;

const rows = TOOLS.map((t) => {
  // What the client actually serializes for each tool in tools/list.
  const wire = JSON.stringify({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema,
  });
  return {
    name: t.name,
    descTokens: countTokens(t.description ?? ""),
    schemaTokens: countTokens(JSON.stringify(t.inputSchema)),
    totalTokens: countTokens(wire),
  };
});

const grandTotal = countTokens(JSON.stringify({ tools: TOOLS }));
rows.sort((a, b) => b.totalTokens - a.totalTokens);

const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);
console.log(`\n  Tool-schema token audit — ${TOOLS.length} tools (gpt-4o tokenizer)\n`);
console.log(`  ${pad("tool", 24)}${padl("desc", 8)}${padl("schema", 9)}${padl("total", 9)}`);
console.log("  " + "─".repeat(50));
for (const r of rows) {
  console.log(`  ${pad(r.name, 24)}${padl(r.descTokens, 8)}${padl(r.schemaTokens, 9)}${padl(r.totalTokens, 9)}`);
}
console.log("  " + "─".repeat(50));
console.log(`  ${pad("ListTools payload total", 24)}${padl("", 8)}${padl("", 9)}${padl(grandTotal, 9)}\n`);
console.log(`  Budget: ${BUDGET_TOKENS} tokens — ${grandTotal <= BUDGET_TOKENS ? "OK" : "OVER"} (${grandTotal})`);
console.log(
  grandTotal <= BUDGET_TOKENS
    ? `  The full 11-tool surface fits comfortably; no profile split needed.\n`
    : `  Over budget — set BRAIN_TOOL_PROFILE=core to load only the essential tools.\n`,
);

process.exit(grandTotal <= BUDGET_TOKENS ? 0 : 1);
