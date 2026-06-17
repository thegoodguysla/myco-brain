#!/usr/bin/env node
/**
 * Contract drift-guard (runs in CI, no network). The agent contract lives on
 * several surfaces; this fails the build if they diverge on the load-bearing
 * line, or if the runtime contract stops being single-sourced from
 * agent-instructions.ts. Cheap insurance against the surfaces drifting apart.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const mcp = join(here, "..", "..");              // mcp-server/
const root = join(mcp, "..", "..");              // repo root

const LOAD_BEARING = "feeds the engine well gets a workspace that grows more certain";

const surfaces = [
  { label: "agent-instructions.ts (manual + RUNTIME_CONTRACT)", path: join(mcp, "src/agent-instructions.ts") },
  { label: "docs/agent-instructions.md", path: join(mcp, "..", "docs/agent-instructions.md") },
  { label: "homepage 'Teach your agent' tab", path: join(root, "packages/web/app/myco/MycoLandingClient.tsx") },
];

let failed = 0;
const ok = (m) => console.log(`ok    ${m}`);
const fail = (m) => { failed++; console.error(`FAIL  ${m}`); };

for (const s of surfaces) {
  let text = "";
  try { text = readFileSync(s.path, "utf8"); } catch { fail(`${s.label} — file not found at ${s.path}`); continue; }
  if (text.includes(LOAD_BEARING)) ok(`${s.label} carries the load-bearing line`);
  else fail(`${s.label} is MISSING the load-bearing line ("...${LOAD_BEARING}...")`);
}

// The runtime contract must stay single-sourced: index.ts builds SERVER_INSTRUCTIONS
// from RUNTIME_CONTRACT, it does not re-hardcode the ladder.
try {
  const index = readFileSync(join(mcp, "src/index.ts"), "utf8");
  if (/SERVER_INSTRUCTIONS\s*=\s*`\$\{RUNTIME_CONTRACT\}/.test(index)) ok("index.ts SERVER_INSTRUCTIONS is single-sourced from RUNTIME_CONTRACT");
  else fail("index.ts SERVER_INSTRUCTIONS is NOT built from RUNTIME_CONTRACT — runtime contract has drifted out of agent-instructions.ts");
} catch { fail("index.ts not found"); }

console.log(failed === 0 ? "\n=== PASS (contract-drift) ===" : `\n=== FAIL (${failed}) ===`);
process.exit(failed === 0 ? 0 : 1);
