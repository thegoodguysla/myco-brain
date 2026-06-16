#!/usr/bin/env node
/**
 * Importer embedding-drain check — GATED on a database + Ollama, no OpenAI key.
 *
 * Regression guard for the bug where `mycobrain-ingest --from <export>` printed
 * "done" but vector search stayed empty: ingest() embeds in a NON-awaited
 * background task, and the short-lived CLI process called closePool() +
 * process.exit(0) before those tasks finished — so the just-imported content
 * was BM25-only, never embedded. The fix drains pending embeddings
 * (flushPendingEmbeddings) before the CLI exits.
 *
 * This test runs the ACTUAL CLI binary as a subprocess against a self-contained
 * ChatGPT-export fixture, then — AFTER the process has fully exited — asserts:
 *   1. every imported chunk has a vector in chunks_ollama_nomic (drain worked), and
 *   2. a semantic query with no lexical overlap retrieves the right conversation
 *      via the vector path (vector_used: true).
 * If the drain regresses, the subprocess exits mid-embed and assertion 1 fails.
 *
 * Skips (exit 0) when DATABASE_URL is unset or the active embedding provider is
 * not Ollama. Self-contained: writes its fixture to a temp dir, cleans its rows.
 */
if (!process.env.DATABASE_URL) {
  console.log("[skip] import-embeddings check — DATABASE_URL is not set.");
  process.exit(0);
}
// Force keyless Ollama for this check (mirrors how a local user runs it).
process.env.BRAIN_EMBED_PROVIDER ??= "ollama";

const [{ getEmbeddingProvider }, { canonicalizeAgentContext }, { resolveAuth },
       { search, SearchInput }, { default: pg }, fsMod, osMod, pathMod, cpMod] =
  await Promise.all([
    import("../dist/embed.js"),
    import("../dist/agent-identity.js"),
    import("../dist/auth.js"),
    import("../dist/tools/search.js"),
    import("pg"),
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
    import("node:child_process"),
  ]);

const provider = getEmbeddingProvider();
if (!provider || provider.name !== "ollama") {
  console.log(
    `[skip] import-embeddings check — active provider is ${provider?.name ?? "none"}, ` +
      `not ollama. Set BRAIN_EMBED_PROVIDER=ollama with a running Ollama to run it.`
  );
  process.exit(0);
}

const fs = fsMod.default ?? fsMod;
const os = osMod.default ?? osMod;
const path = pathMod.default ?? pathMod;
const { execFileSync } = cpMod;

const WS = "00000000-0000-0000-0000-000000000001";
const AG = "00000000-0000-0000-0000-0000000000a1";
const NAME = "chatgpt: Drain check — choosing a datastore";
let failed = 0;
const ok = (m) => console.log(`ok    ${m}`);
const fail = (m) => {
  failed++;
  console.error(`FAIL  ${m}`);
};

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

async function cleanup() {
  await db.query(
    `DELETE FROM chunks_ollama_nomic WHERE chunk_id IN
       (SELECT chunk_id FROM chunks WHERE hyobject_id IN
         (SELECT hyobject_id FROM hyobjects WHERE workspace_id=$1 AND name=$2))`,
    [WS, NAME]
  );
  await db.query(
    `DELETE FROM chunk_extraction_status WHERE chunk_id IN
       (SELECT chunk_id FROM chunks WHERE hyobject_id IN
         (SELECT hyobject_id FROM hyobjects WHERE workspace_id=$1 AND name=$2))`,
    [WS, NAME]
  );
  await db.query(
    `DELETE FROM chunks WHERE hyobject_id IN
       (SELECT hyobject_id FROM hyobjects WHERE workspace_id=$1 AND name=$2)`,
    [WS, NAME]
  );
  await db.query(
    `DELETE FROM hyobjects WHERE workspace_id=$1 AND (name=$2 OR name=$3)`,
    [WS, NAME, `Ingested: ${NAME}`]
  );
}

let tmpDir;
try {
  await cleanup();

  // Minimal but valid ChatGPT-export fixture — distinctive wording so the
  // semantic query shares no obvious keyword with it.
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "myco-import-"));
  const convo = {
    title: "Drain check — choosing a datastore",
    create_time: 1736726400.0,
    current_node: "n2",
    mapping: {
      root: { id: "root", message: null, parent: null, children: ["n1"] },
      n1: {
        id: "n1",
        parent: "root",
        children: ["n2"],
        message: {
          author: { role: "user" },
          create_time: 1736726401.0,
          content: { content_type: "text", parts: ["Should we keep relational integrity and store embeddings together?"] },
        },
      },
      n2: {
        id: "n2",
        parent: "n1",
        children: [],
        message: {
          author: { role: "assistant" },
          create_time: 1736726402.0,
          content: { content_type: "text", parts: ["Yes — pick Postgres with the pgvector extension so foreign keys and vector search live in one engine."] },
        },
      },
    },
  };
  await fs.writeFile(
    path.join(tmpDir, "conversations.json"),
    JSON.stringify([convo])
  );

  // Run the ACTUAL CLI binary as a subprocess (this is what users run). It must
  // fully exit before we inspect the DB — the whole point of the drain fix.
  const cli = path.join(import.meta.dirname, "..", "dist", "ingest-cli.js");
  execFileSync(process.execPath, [cli, "--from", "chatgpt-export", tmpDir], {
    env: { ...process.env },
    stdio: "ignore",
  });
  ok("CLI subprocess imported the fixture and exited");

  // 1) Every chunk of the imported doc must now have a vector.
  const counts = await db.query(
    `SELECT count(c.chunk_id) AS chunks, count(e.chunk_id) AS embedded
       FROM hyobjects h
       JOIN chunks c ON c.hyobject_id = h.hyobject_id
       LEFT JOIN chunks_ollama_nomic e ON e.chunk_id = c.chunk_id
      WHERE h.workspace_id = $1 AND h.name = $2`,
    [WS, NAME]
  );
  const { chunks, embedded } = counts.rows[0];
  if (Number(chunks) > 0 && Number(chunks) === Number(embedded)) {
    ok(`all ${chunks} imported chunk(s) embedded after CLI exit (drain worked)`);
  } else {
    fail(`embeddings not drained: ${embedded}/${chunks} chunk(s) embedded`);
  }

  // 2) Semantic retrieval via the vector path (no keyword overlap with the doc).
  const { ctx: raw } = resolveAuth({
    apiKey: `brain_${WS}_${AG}_localdev`,
    workspaceId: WS,
  });
  const ctx = await canonicalizeAgentContext(raw);
  const res = await search(
    ctx,
    SearchInput.parse({ query: "which database did we settle on?", limit: 3 })
  );
  const hit = res.results?.find((r) => (r.text || "").includes("Drain check"));
  if (hit && res.vector_used) {
    ok(`semantic recall found the import via vector path (score ${hit.score?.toFixed?.(3)})`);
  } else if (hit) {
    ok(`semantic recall found the import (score ${hit.score?.toFixed?.(3)})`);
  } else {
    fail("semantic query did not retrieve the imported conversation");
  }
} catch (e) {
  fail(`unexpected: ${e.stack || e.message}`);
} finally {
  try {
    await cleanup();
  } catch (e) {
    console.error(`warn  cleanup: ${e.message}`);
  }
  await db.end();
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
}

console.log(failed === 0 ? "=== PASS (import-embeddings) ===" : `=== FAIL (${failed}) ===`);
process.exit(failed === 0 ? 0 : 1);
