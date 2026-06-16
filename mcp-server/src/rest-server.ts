#!/usr/bin/env node
/**
 * `mycobrain-rest` — a small, read-only HTTP API in front of the brain, for
 * consumers that don't speak MCP (a web app, an automation, a partner
 * backend). Exposes exactly two read tools — search and why — plus health.
 *
 *   GET  /health                      → { status, version }            (no auth)
 *   POST /search  { query, limit? }   → hybrid search results
 *   POST /why     { hyobject_id | entity_id | … } → provenance chain
 *
 * Auth: a per-agent key in `Authorization: Bearer brain_…` or `X-API-Key:`.
 * The key alone scopes every query to its workspace via the same row-level
 * security the MCP server uses — this endpoint adds no privileges of its own
 * and has NO write paths. Only `brain_` keys are accepted (the RLS-bypassing
 * service-role JWT path is refused over the network). Treat the key like a
 * password: it is a bearer credential, not signature-verified, so anyone
 * holding it is that agent. Binds to 127.0.0.1 by default; set
 * BRAIN_REST_HOST=0.0.0.0 (behind your own TLS/proxy) only when you mean to
 * expose it.
 *
 *   Config: BRAIN_REST_PORT (default 8787), BRAIN_REST_HOST (default 127.0.0.1)
 */
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { resolveAuth, AuthError } from "./auth.js";
import { canonicalizeAgentContext } from "./agent-identity.js";
import { search, SearchInput } from "./tools/search.js";
import { why, WhyInput } from "./tools/why.js";
import { closePool } from "./db.js";

const { version: VERSION } = createRequire(import.meta.url)("../package.json") as { version: string };
const MAX_BODY_BYTES = 64 * 1024; // search queries are small; cap to refuse DoS bodies

const json = (res: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
};

/** Read the request body as JSON, enforcing the size cap. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks: Buffer[] = [];
    const finish = (fn: () => void) => { if (!done) { done = true; fn(); } };
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // Reject and stop buffering, but DON'T destroy the socket — let the
        // handler send a clean 413 (a reset would surface as a network error).
        chunks.length = 0;
        req.removeAllListeners("data");
        req.resume(); // drain the rest so the connection can complete
        finish(() => reject(Object.assign(new Error("request body too large"), { httpStatus: 413 })));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      finish(() => {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(Object.assign(new Error("request body is not valid JSON"), { httpStatus: 400 }));
        }
      });
    });
    req.on("error", (err) => finish(() => reject(err)));
  });
}

/** Extract the brain key from Authorization: Bearer … or X-API-Key. */
function keyFromHeaders(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const x = req.headers["x-api-key"];
  if (typeof x === "string" && x.trim()) return x.trim();
  return null;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = `${req.method} ${url.pathname}`;

  // Health is unauthenticated and read-only.
  if (route === "GET /health") return json(res, 200, { status: "ok", version: VERSION });

  if (url.pathname !== "/search" && url.pathname !== "/why") {
    return json(res, 404, { error: "not found", routes: ["GET /health", "POST /search", "POST /why"] });
  }
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return json(res, 405, { error: "method not allowed — use POST" });
  }

  // Authenticate. The key scopes the query to its workspace via RLS.
  const apiKey = keyFromHeaders(req);
  if (!apiKey) {
    res.setHeader("www-authenticate", "Bearer");
    return json(res, 401, { error: "missing API key — send Authorization: Bearer brain_… or X-API-Key" });
  }
  // Only per-agent brain_ keys are accepted over the network. The service-role
  // JWT path (resolveAuth) is RLS-BYPASSING and meant for trusted local/system
  // callers of the MCP server — it must never be reachable from a network
  // listener, where a client could present any eyJ… string for full access.
  if (!apiKey.startsWith("brain_")) {
    return json(res, 401, { error: "invalid API key — a brain_<workspace>_<agent>_<secret> key is required" });
  }
  let ctx;
  try {
    ctx = await canonicalizeAgentContext(resolveAuth({ apiKey }).ctx);
  } catch (err) {
    // A well-formed key whose workspace/agent can't be resolved (e.g. a forged
    // key for a nonexistent workspace) is an AUTH failure, not a server error —
    // return 401, never 500. The real cause is logged server-side, opaque to
    // the client so it can't probe which workspaces exist.
    if (!(err instanceof AuthError)) {
      console.error("[rest] auth canonicalization failed:", (err as Error).message);
    }
    return json(res, 401, { error: "invalid API key" });
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return json(res, (err as { httpStatus?: number }).httpStatus ?? 400, { error: (err as Error).message });
  }

  try {
    if (url.pathname === "/search") {
      const input = SearchInput.parse(body);
      return json(res, 200, await search(ctx, input));
    }
    // /why
    const input = WhyInput.parse(body);
    return json(res, 200, await why(ctx, input));
  } catch (err) {
    // Zod validation errors are the caller's fault → 400 with detail; anything
    // else is logged server-side and returned as an opaque 500 (no leakage).
    const name = (err as { name?: string }).name;
    if (name === "ZodError") {
      // Surface only field path + message, not the raw schema internals.
      const issues = ((err as { issues?: { path?: unknown[]; message?: string }[] }).issues ?? []).map(
        (i) => ({ path: (i.path ?? []).join("."), message: i.message })
      );
      return json(res, 400, { error: "invalid request", issues });
    }
    console.error("[rest] handler error:", err);
    return json(res, 500, { error: "internal error" });
  }
}

const port = Number.parseInt(process.env.BRAIN_REST_PORT ?? "8787", 10);
const host = process.env.BRAIN_REST_HOST ?? "127.0.0.1";

export const server = createServer((req, res) => {
  // Per-request idle timeout — a slow client can't pin a connection forever.
  req.setTimeout(15_000, () => req.destroy());
  handle(req, res).catch((err) => {
    console.error("[rest] unhandled:", err);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  });
});
// Slowloris guards: bound how long headers and the whole request may take.
server.headersTimeout = 10_000;
server.requestTimeout = 20_000;
server.maxConnections = 256;

// Don't auto-listen when imported by a test; only when run directly.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  server.listen(port, host, () => {
    console.log(`mycobrain-rest ${VERSION} — read-only API on http://${host}:${port}`);
    console.log(`  GET /health · POST /search · POST /why   (Authorization: Bearer brain_…)`);
    if (host === "0.0.0.0") {
      console.log(`  ⚠ bound to 0.0.0.0 — put TLS + a proxy in front; the key is the only credential.`);
    }
  });
  const shutdown = () => server.close(() => closePool().finally(() => process.exit(0)));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
