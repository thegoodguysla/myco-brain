#!/usr/bin/env node
/**
 * Read-only REST endpoint check (WO-7) — GATED on a database, no LLM.
 *
 * Boots the server on an ephemeral port and exercises every route + auth path:
 *   - GET /health           → 200, no auth
 *   - POST /search (no key) → 401
 *   - POST /search (bad key)→ 401
 *   - POST /search (key)    → 200, results array
 *   - POST /why  (key)      → 200, provenance for a real hyobject
 *   - GET  /search          → 405 (read-only POST routes)
 *   - POST /nope            → 404
 *   - oversized body        → 413
 *
 * Skips (exit 0) when DATABASE_URL is unset — checked BEFORE dist/ imports.
 */
if (!process.env.DATABASE_URL) {
  console.log("[skip] rest check — DATABASE_URL is not set.");
  process.exit(0);
}

const [{ server }, { closePool }, { default: pg }] = await Promise.all([
  import("../dist/rest-server.js"),
  import("../dist/db.js"),
  import("pg"),
]);

const WS = "00000000-0000-0000-0000-000000000001";
const KEY = `brain_${WS}_00000000-0000-0000-0000-0000000000a1_localdev`;
let failed = 0;
const ok = (m) => console.log(`ok    ${m}`);
const fail = (m) => { failed++; console.error(`FAIL  ${m}`); };

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const hyobj = (await db.query(`SELECT hyobject_id FROM hyobjects WHERE workspace_id=$1 LIMIT 1`, [WS])).rows[0]?.hyobject_id;
await db.end();

const base = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
});

const call = (method, path, { key, body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: body !== undefined ? body : undefined,
  });

// ── health (no auth) ─────────────────────────────────────────────────────────
let r = await call("GET", "/health");
let j = await r.json().catch(() => ({}));
if (r.status === 200 && j.status === "ok" && j.version) ok(`GET /health → 200 (v${j.version})`);
else fail(`health wrong: ${r.status} ${JSON.stringify(j)}`);

// ── auth required ────────────────────────────────────────────────────────────
r = await call("POST", "/search", { body: JSON.stringify({ query: "x" }) });
if (r.status === 401) ok("POST /search with no key → 401"); else fail(`no-key expected 401, got ${r.status}`);

r = await call("POST", "/search", { key: "not-a-brain-key", body: JSON.stringify({ query: "x" }) });
if (r.status === 401) ok("POST /search with malformed key → 401"); else fail(`bad-key expected 401, got ${r.status}`);

// A JWT-shaped key must NOT reach the RLS-bypassing service-role branch.
r = await call("POST", "/search", { key: "eyJhbGciOiJIUzI1NiJ9.payload.sig", body: JSON.stringify({ query: "x" }) });
if (r.status === 401) ok("POST /search with JWT-shaped key → 401 (service-role branch refused over network)");
else fail(`JWT key expected 401, got ${r.status}`);

// ── search happy path ────────────────────────────────────────────────────────
r = await call("POST", "/search", { key: KEY, body: JSON.stringify({ query: "the", limit: 3 }) });
j = await r.json().catch(() => ({}));
if (r.status === 200 && Array.isArray(j.results)) ok(`POST /search with key → 200 (${j.results.length} result(s))`);
else fail(`search expected 200 + results[], got ${r.status} ${JSON.stringify(j).slice(0, 120)}`);

// ── invalid input → 400 ──────────────────────────────────────────────────────
r = await call("POST", "/search", { key: KEY, body: JSON.stringify({ notquery: 1 }) });
if (r.status === 400) ok("POST /search with invalid body → 400"); else fail(`invalid body expected 400, got ${r.status}`);

// ── why happy path ───────────────────────────────────────────────────────────
if (hyobj) {
  r = await call("POST", "/why", { key: KEY, body: JSON.stringify({ hyobject_id: hyobj }) });
  j = await r.json().catch(() => ({}));
  if (r.status === 200 && j.subject) ok("POST /why with key → 200 (provenance returned)");
  else fail(`why expected 200 + subject, got ${r.status} ${JSON.stringify(j).slice(0, 120)}`);
} else {
  ok("POST /why skipped — no hyobject in workspace to trace");
}

// ── read-only: GET on a POST route → 405 ─────────────────────────────────────
r = await call("GET", "/search", { key: KEY });
if (r.status === 405) ok("GET /search → 405 (read-only POST route)"); else fail(`GET /search expected 405, got ${r.status}`);

// ── unknown route → 404 ──────────────────────────────────────────────────────
r = await call("POST", "/ingest", { key: KEY, body: JSON.stringify({}) });
if (r.status === 404) ok("POST /ingest → 404 (no write routes exist)"); else fail(`unknown route expected 404, got ${r.status}`);

// ── oversized body → 413 ─────────────────────────────────────────────────────
r = await call("POST", "/search", { key: KEY, body: JSON.stringify({ query: "x".repeat(70 * 1024) }) });
if (r.status === 413) ok("oversized body → 413 (DoS cap)"); else fail(`oversized body expected 413, got ${r.status}`);

await new Promise((resolve) => server.close(resolve));
await closePool().catch(() => {});
console.log(`\n=== ${failed === 0 ? "PASS" : "FAIL"} (rest) ===`);
process.exit(failed === 0 ? 0 : 1);
