#!/usr/bin/env node
/**
 * Local-embeddings (Ollama) semantic-search check — GATED.
 *
 * Skips (exit 0) unless an Ollama embedding provider is active
 * (BRAIN_EMBED_PROVIDER=ollama, or BRAIN_OLLAMA_BASE_URL set with no OpenAI
 * key). When active, it proves keyless semantic search works end-to-end:
 *   - ingest a document with NO lexical overlap with the query
 *   - brain_search must retrieve it with vector_used: true (so a pure
 *     full-text/BM25 path could not have found it)
 *   - its vector must land in chunks_ollama_nomic (768d)
 *
 * Requires: DATABASE_URL (migrated + seeded), a running Ollama with
 * nomic-embed-text pulled, and the server built (dist/). This is intentionally
 * NOT part of the default CI quickstart job, which stays keyless/Ollama-free.
 */
import pg from "pg";
import { canonicalizeAgentContext } from "../dist/agent-identity.js";
import { resolveAuth } from "../dist/auth.js";
import { getEmbeddingProvider } from "../dist/embed.js";
import { ingest, IngestInput } from "../dist/tools/ingest.js";
import { search, SearchInput } from "../dist/tools/search.js";

const provider = getEmbeddingProvider();
if (!provider || provider.name !== "ollama") {
  console.log(
    `[skip] local-embeddings check — active embedding provider is ` +
      `${provider?.name ?? "none"}, not ollama. ` +
      `Set BRAIN_EMBED_PROVIDER=ollama to run it.`
  );
  process.exit(0);
}

const WS = "00000000-0000-0000-0000-000000000001";
const AG = "00000000-0000-0000-0000-0000000000a1";
const { ctx: raw } = resolveAuth({
  apiKey: `brain_${WS}_${AG}_localdev`,
  workspaceId: WS,
});
const ctx = await canonicalizeAgentContext(raw);

const run = `${Date.now()}`;
let failed = 0;
const fail = (m) => {
  failed++;
  console.error(`FAIL  ${m}`);
};
const ok = (m) => console.log(`ok    ${m}`);

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const countEmb = async () =>
  Number(
    (await db.query("SELECT count(*)::int AS n FROM chunks_ollama_nomic")).rows[0].n
  );

const before = await countEmb();

// Semantic doc — deliberately shares NO query tokens with the search below.
// The trailing run id keeps content unique so the content-hash dedup doesn't
// skip re-ingestion (and re-embedding) on repeat runs. "(ref ...)" adds no
// query tokens (cat/nap/sleep).
const docText =
  `The marmalade tabby dozed in a warm sunbeam by the bay window all afternoon. (ref ${run})`;
const ing = await ingest(
  ctx,
  IngestInput.parse({
    mode: "text",
    text: docText,
    name: `cat-nap-${run}`,
    idempotency_key: `cat-${run}`,
    trace_id: `t-cat-${run}`,
    raw_payload: { t: "cat" },
  })
);
// Distractor document.
await ingest(
  ctx,
  IngestInput.parse({
    mode: "text",
    text: `The quarterly budget spreadsheet is overdue for finance review. (ref ${run})`,
    name: `budget-${run}`,
    idempotency_key: `bud-${run}`,
    trace_id: `t-bud-${run}`,
    raw_payload: { t: "bud" },
  })
);

// Embedding is intentionally non-blocking (ingest returns before vectors are
// written), so poll until both documents' vectors land — up to ~20s.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let after = before;
for (let i = 0; i < 40 && after < before + 2; i++) {
  await sleep(500);
  after = await countEmb();
}
if (after > before) ok(`chunks_ollama_nomic populated (+${after - before} vectors)`);
else
  fail(
    `chunks_ollama_nomic gained no rows (${before} -> ${after}); embeddings not stored`
  );

// "cat" / "nap" / "sleep" appear nowhere in docText — a lexical match is impossible.
const res = await search(
  ctx,
  SearchInput.parse({ query: "where did the cat take a nap", limit: 5 })
);

if (res.retrieval_metadata?.vector_used === true)
  ok("search used vectors (vector_used: true)");
else
  fail(`vector_used was ${res.retrieval_metadata?.vector_used}, expected true`);

const top = res.results?.[0];
const inResults = res.results?.some((r) => r.hyobject_id === ing.hyobject_id);
if (top?.hyobject_id === ing.hyobject_id)
  ok("semantic match: cat-nap doc ranked #1 despite zero lexical overlap");
else if (inResults)
  ok("semantic match: cat-nap doc retrieved despite zero lexical overlap");
else
  fail("semantic match: cat-nap doc not retrieved for a lexically-disjoint query");

await db.end();
console.log(`\n=== ${failed === 0 ? "PASS" : "FAIL"} (local-embeddings) ===`);
process.exit(failed === 0 ? 0 : 1);
