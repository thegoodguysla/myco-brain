#!/usr/bin/env node
/**
 * Onboarding command check — GATED on a database, no LLM, no Ollama required.
 *
 * Verifies mycobrain-onboard's two stateful paths against the real CLI binary:
 *
 *   --reset-demo  removes ONLY bundled sample data (demo-memory-* and the
 *                 examples/demo-corpus directory ingest) and PRESERVES a user's
 *                 own import (chatgpt:*) and any real memory. This is the safety
 *                 property: a real ChatGPT/Claude import must never be deleted.
 *
 *   --tour        is ephemeral — it ingests sample memories, shows recall, then
 *                 self-cleans, leaving the workspace's recallable count unchanged.
 *
 * Self-contained: plants its rows via the real ingest() tool and cleans them up.
 * Skips (exit 0) when DATABASE_URL is unset.
 */
if (!process.env.DATABASE_URL) {
  console.log("[skip] onboard check — DATABASE_URL is not set.");
  process.exit(0);
}

const [{ canonicalizeAgentContext }, { resolveAuth }, { ingest, IngestInput },
       { default: pg }, cpMod, pathMod] = await Promise.all([
  import("../dist/agent-identity.js"),
  import("../dist/auth.js"),
  import("../dist/tools/ingest.js"),
  import("pg"),
  import("node:child_process"),
  import("node:path"),
]);
const { execFileSync } = cpMod;
const path = pathMod.default ?? pathMod;

const WS = "00000000-0000-0000-0000-000000000001";
const AG = "00000000-0000-0000-0000-0000000000a1";
const { ctx: raw } = resolveAuth({ apiKey: `brain_${WS}_${AG}_localdev`, workspaceId: WS });
const ctx = await canonicalizeAgentContext(raw);

const run = `${Date.now()}`;
const REAL = `onboard-real-keepme-${run}`;
const IMPORT = `chatgpt: My Real Import ${run}`;
const DEMO_MEM = `demo-memory-xtest-${run}`;
const DEMO_DOC = `team-${run}.md`;

let failed = 0;
const ok = (m) => console.log(`ok    ${m}`);
const fail = (m) => {
  failed++;
  console.error(`FAIL  ${m}`);
};

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const exists = async (name) => {
  const r = await db.query(
    `SELECT count(*)::int AS n FROM hyobjects WHERE workspace_id=$1 AND name=$2`,
    [WS, name]
  );
  return r.rows[0].n > 0;
};
const memCount = async () => {
  const r = await db.query(
    `SELECT count(*)::int AS n FROM hyobjects WHERE workspace_id=$1 AND type_id <> 80`,
    [WS]
  );
  return r.rows[0].n;
};
const cli = path.join(import.meta.dirname, "..", "dist", "onboard.js");
const onboard = (...args) =>
  execFileSync(process.execPath, [cli, ...args].filter(Boolean), {
    env: { ...process.env },
    stdio: "ignore",
  });

async function cleanup() {
  for (const name of [REAL, IMPORT, DEMO_MEM, DEMO_DOC]) {
    await db.query(
      `DELETE FROM chunks WHERE hyobject_id IN (SELECT hyobject_id FROM hyobjects WHERE workspace_id=$1 AND name=$2)`,
      [WS, name]
    ).catch(() => {});
    await db.query(`DELETE FROM hyobjects WHERE workspace_id=$1 AND (name=$2 OR name=$3)`, [
      WS,
      name,
      `Ingested: ${name}`,
    ]).catch(() => {});
  }
}

try {
  await cleanup();

  // --- Plant the four kinds of content via the REAL ingest() tool ----------
  await ingest(ctx, IngestInput.parse({ mode: "text", text: `Real note ${run}: keep me forever.`, name: REAL }));
  await ingest(ctx, IngestInput.parse({
    mode: "text", text: `User's own imported ChatGPT conversation ${run}.`,
    name: IMPORT, tags: { source: `chatgpt-export:my.zip#1`, provider: "chatgpt" },
  }));
  await ingest(ctx, IngestInput.parse({ mode: "text", text: `Demo sample memory ${run}.`, name: DEMO_MEM }));
  await ingest(ctx, IngestInput.parse({
    mode: "text", text: `Demo corpus doc ${run}.`,
    name: DEMO_DOC, tags: { source: `dir:/somewhere/examples/demo-corpus`, path: DEMO_DOC },
  }));

  for (const [name, label] of [[REAL, "real memory"], [IMPORT, "user import"], [DEMO_MEM, "demo memory"], [DEMO_DOC, "demo-corpus doc"]]) {
    if (!(await exists(name))) fail(`setup: ${label} (${name}) was not planted`);
  }

  // --- Test 1a: --reset-demo WITHOUT --yes is a dry run (deletes nothing) ---
  onboard("--reset-demo");
  if (await exists(DEMO_MEM)) ok("reset-demo dry run preserved everything (no --yes)");
  else fail("reset-demo dry run deleted data without --yes!");

  // --- Test 1b: --reset-demo --yes removes only the bundled samples ---------
  onboard("--reset-demo", "--yes");
  if (await exists(DEMO_MEM)) fail("reset-demo did NOT remove the demo memory"); else ok("reset-demo removed the demo memory (demo-memory-*)");
  if (await exists(DEMO_DOC)) fail("reset-demo did NOT remove the demo-corpus doc"); else ok("reset-demo removed the demo-corpus doc (source dir:%demo-corpus)");
  if (await exists(IMPORT)) ok("reset-demo PRESERVED the user's own ChatGPT import (safety)"); else fail("reset-demo wrongly deleted the user's own import!");
  if (await exists(REAL)) ok("reset-demo PRESERVED the user's real memory"); else fail("reset-demo wrongly deleted a real memory!");

  // --- Test 2: --tour is ephemeral (count unchanged) -----------------------
  const before = await memCount();
  onboard("--tour");
  const after = await memCount();
  if (after === before) ok(`tour left the workspace unchanged (${before} → ${after} recallable docs)`);
  else fail(`tour changed the workspace count: ${before} → ${after} (should self-clean)`);
} catch (e) {
  fail(`unexpected: ${e.stack || e.message}`);
} finally {
  await cleanup();
  await db.end();
}

console.log(failed === 0 ? "=== PASS (onboard) ===" : `=== FAIL (${failed}) ===`);
process.exit(failed === 0 ? 0 : 1);
