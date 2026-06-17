#!/usr/bin/env node
/**
 * mycobrain-ingest — bulk-ingest a local directory or a GitHub repo into Brain.
 *
 * This is the "point it at your stuff and it remembers" path for the free,
 * self-hosted tier: it reuses brain_ingest's text mode, so every file is
 * chunked and full-text-indexed immediately — searchable across sessions with
 * no API key required. Add an OpenAI key and the embeddings/graph fill in too.
 *
 * Usage:
 *   mycobrain-ingest ./docs                 # a local directory (recursive)
 *   mycobrain-ingest ./README.md            # a single file
 *   mycobrain-ingest github:owner/repo      # a public GitHub repo
 *   mycobrain-ingest https://github.com/owner/repo
 *
 * Auth/connection come from the same env vars the MCP server uses:
 *   DATABASE_URL, BRAIN_WORKSPACE_ID, BRAIN_API_KEY
 * For private GitHub repos, set GITHUB_TOKEN.
 */
import "dotenv/config";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { canonicalizeAgentContext } from "./agent-identity.js";
import { resolveAuth } from "./auth.js";
import { ingest, IngestInput, flushPendingEmbeddings } from "./tools/ingest.js";
import { closePool, type SessionContext } from "./db.js";
import {
  ingestDirectory,
  looksBinary,
  parseGitHubTarget,
  detectExportKind,
} from "./ingest-cli.lib.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
import {
  parseChatGptConversations,
  parseClaudeConversations,
} from "./export-import.lib.js";

// walk() and ingestDirectory() moved to ingest-cli.lib.js so onboard can reuse
// them in-process. The per-file console output now rides on onFile/onError.
const dirLog = {
  onFile: (rel: string) => console.log(`  + ${rel}`),
  onError: (rel: string, msg: string) => console.error(`  ! ${rel}: ${msg}`),
};

// List the .zip files in a directory, newest first.
async function listZips(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const zips = names.filter((n) => n.toLowerCase().endsWith(".zip")).map((n) => path.join(dir, n));
  const withTime = await Promise.all(
    zips.map(async (p) => ({ p, t: await fs.stat(p).then((s) => s.mtimeMs).catch(() => 0) }))
  );
  return withTime.sort((a, b) => b.t - a.t).map((x) => x.p);
}

// Read the entry names inside a zip (needs `unzip` on PATH).
function zipEntries(zipPath: string): string[] {
  return execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Watch ~/Downloads for a ChatGPT/Claude export .zip and auto-ingest it the moment
// it lands. Opt-in only, with a visible "watching" line. --once processes any
// export already present and exits; default polls until interrupted.
async function watchDownloads(ctx: SessionContext, once: boolean): Promise<void> {
  const dir = process.env.BRAIN_WATCH_DIR || path.join(os.homedir(), "Downloads");
  const seen = new Set<string>();

  const tryIngest = async (zipPath: string): Promise<boolean> => {
    if (seen.has(zipPath)) return false;
    let kind: ReturnType<typeof detectExportKind>;
    try {
      kind = detectExportKind(zipEntries(zipPath));
    } catch {
      return false; // not a readable zip, or unzip is unavailable
    }
    if (!kind) return false;
    seen.add(zipPath);
    const who = kind === "chatgpt-export" ? "ChatGPT" : "Claude";
    console.log(`\nDetected ${who} export: ${path.basename(zipPath)} — importing…`);
    const r = await ingestAssistantExport(ctx, kind, zipPath);
    console.log(`Imported ${r.ingested} conversation(s), ${r.skipped} already known (deduped).`);
    console.log(`Ask your agent: "what did I discuss with ${who} about <topic>?"`);
    return true;
  };

  console.log(`Watching ${dir} for a ChatGPT or Claude export .zip…`);
  let any = false;
  for (const z of await listZips(dir)) {
    if (await tryIngest(z)) {
      any = true;
      if (once) return;
    }
  }
  if (once) {
    if (!any) console.log(`No export .zip found in ${dir} yet. Request your export, then re-run.`);
    return;
  }
  console.log("(opt-in; nothing leaves your machine; Ctrl-C to stop)");
  for (;;) {
    await sleep(3000);
    for (const z of await listZips(dir)) await tryIngest(z);
  }
}

async function ingestGitHub(
  ctx: SessionContext,
  repoSlug: string
): Promise<{ ingested: number; skipped: number }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "myco-gh-"));
  const token = process.env.GITHUB_TOKEN;
  // Embed the token in the clone URL for private repos. Never logged.
  const cloneUrl = token
    ? `https://x-access-token:${token}@github.com/${repoSlug}.git`
    : `https://github.com/${repoSlug}.git`;
  console.log(`Cloning github.com/${repoSlug} …`);
  try {
    execFileSync("git", ["clone", "--depth", "1", cloneUrl, tmp], {
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch {
    throw new Error(
      `git clone failed for ${repoSlug}. Is git installed and the repo accessible? ` +
        `For private repos set GITHUB_TOKEN.`
    );
  }
  try {
    return await ingestDirectory(ctx, tmp, `github:${repoSlug}`, dirLog);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// ── ChatGPT / Claude memory-export import ───────────────────────────────────
// `--from chatgpt-export <path>` / `--from claude-export <path>` where path is
// the export .zip (needs `unzip` on PATH), an extracted directory, or
// conversations.json itself. One document per conversation; per-conversation
// idempotency keys + content-hash dedup make re-imports safe.
async function ingestAssistantExport(
  ctx: SessionContext,
  kind: "chatgpt-export" | "claude-export",
  target: string
): Promise<{ ingested: number; skipped: number }> {
  const resolved = path.resolve(target);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) throw new Error(`Export path not found: ${resolved}`);

  const notAnExport = (extra: string) =>
    new Error(
      `${resolved} doesn't look like a ${kind} — expected the export .zip, an ` +
        `extracted folder containing conversations.json, or conversations.json itself. ${extra}`
    );

  let rawJson: string;
  if (stat.isDirectory()) {
    rawJson = await fs
      .readFile(path.join(resolved, "conversations.json"), "utf8")
      .catch(() => {
        throw notAnExport("No conversations.json in that folder.");
      });
  } else if (resolved.toLowerCase().endsWith(".zip")) {
    try {
      rawJson = execFileSync("unzip", ["-p", resolved, "conversations.json"], {
        maxBuffer: 1024 * 1024 * 1024,
      }).toString("utf8");
    } catch (err) {
      throw new Error(
        `Could not read conversations.json from the zip (is \`unzip\` installed, ` +
          `and is this a ${kind}?): ${(err as Error).message}`
      );
    }
  } else {
    rawJson = await fs.readFile(resolved, "utf8");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw notAnExport(`Its conversations.json is not valid JSON (${(err as Error).message}).`);
  }

  const provider = kind === "chatgpt-export" ? "chatgpt" : "claude";
  const conversations =
    kind === "chatgpt-export"
      ? parseChatGptConversations(parsed)
      : parseClaudeConversations(parsed);
  if (conversations.length === 0) {
    console.log(
      `No conversations found in ${path.basename(resolved)} — nothing to import. ` +
        `(Is this the right export type? You passed --from ${kind}.)`
    );
    return { ingested: 0, skipped: 0 };
  }
  console.log(`Found ${conversations.length} conversation(s) in ${path.basename(resolved)}.`);

  // Dedup is content-hash based (one document per conversation, keyed by a
  // sha256 of its text). One failed conversation must not abort the rest.
  let ingested = 0;
  let skipped = 0;
  let failed = 0;
  for (const conv of conversations) {
    try {
      const res = await ingest(ctx, IngestInput.parse({
        mode: "text",
        text: conv.text,
        name: `${provider}: ${conv.title}`.slice(0, 480),
        type_id: 1,
        tags: {
          source: `${kind}:${path.basename(resolved)}#${conv.id}`,
          provider,
          conversation_id: conv.id,
          message_count: String(conv.messageCount),
          ...(conv.createdAt ? { conversation_created_at: conv.createdAt } : {}),
        },
      }));
      if (res.deduped) skipped++;
      else ingested++;
    } catch (err) {
      failed++;
      console.error(`  ! skipped "${conv.title}" (${conv.id}): ${(err as Error).message}`);
    }
  }
  if (failed > 0) console.log(`${failed} conversation(s) failed and were skipped.`);
  return { ingested, skipped };
}

function usage(): void {
  console.log(
    `mycobrain-ingest — bulk-ingest a directory or GitHub repo into Brain\n\n` +
      `Usage:\n` +
      `  mycobrain-ingest <path>              # local file or directory (recursive)\n` +
      `  mycobrain-ingest github:owner/repo   # a GitHub repository\n` +
      `  mycobrain-ingest https://github.com/owner/repo\n` +
      `  mycobrain-ingest --from chatgpt-export ./export.zip   # OpenAI data export (zip, dir, or conversations.json)\n` +
      `  mycobrain-ingest --from claude-export ./export.zip    # claude.ai data export\n\n` +
      `Connection (same env as the MCP server):\n` +
      `  DATABASE_URL, BRAIN_WORKSPACE_ID, BRAIN_API_KEY\n` +
      `  GITHUB_TOKEN (optional, for private repos)\n` +
      `  Unset? Defaults to the docker-compose quickstart stack on localhost.\n`
  );
}

// The docker-compose quickstart seeds this workspace/agent/key — they are
// deliberately public, so a fresh `docker compose up -d` followed by a bare
// `mycobrain-ingest <path>` works with zero env configuration. Any env var
// you set wins over these.
const LOCALDEV_DATABASE_URL = "postgresql://brain:brain@localhost:5432/brain";
const LOCALDEV_API_KEY =
  "brain_00000000-0000-0000-0000-000000000001_00000000-0000-0000-0000-0000000000a1_localdev";

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target || target === "-h" || target === "--help") {
    usage();
    process.exit(target ? 0 : 1);
  }

  if (!process.env.DATABASE_URL && !process.env.SUPABASE_DB_URL) {
    process.env.DATABASE_URL = LOCALDEV_DATABASE_URL;
    console.log(
      `No DATABASE_URL set — using the local quickstart stack (${LOCALDEV_DATABASE_URL}).`
    );
  }

  const auth = resolveAuth({
    apiKey: process.env.BRAIN_API_KEY ?? LOCALDEV_API_KEY,
    workspaceId: process.env.BRAIN_WORKSPACE_ID,
    agentId: process.env.BRAIN_AGENT_ID,
  });
  const ctx = await canonicalizeAgentContext(auth.ctx, {
    rawApiKey: auth.rawKey,
  });

  const started = Date.now();
  let result: { ingested: number; skipped: number };

  if (target === "--from") {
    const kind = process.argv[3];
    const exportPath = process.argv[4];
    if ((kind !== "chatgpt-export" && kind !== "claude-export") || !exportPath) {
      usage();
      process.exit(1);
    }
    result = await ingestAssistantExport(ctx, kind, exportPath);
    const secsX = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      `\nDone in ${secsX}s — ${result.ingested} conversation(s) ingested, ${result.skipped} already known (deduped).\n` +
        `Ask your agent: "what did I discuss with ${kind === "chatgpt-export" ? "ChatGPT" : "Claude"} about <topic>?"`
    );
    return;
  }

  if (target === "--watch-downloads") {
    await watchDownloads(ctx, process.argv.includes("--once"));
    return;
  }

  const repoSlug = parseGitHubTarget(target);
  if (repoSlug) {
    result = await ingestGitHub(ctx, repoSlug);
  } else {
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) throw new Error(`Path not found: ${target}`);
    if (stat.isDirectory()) {
      result = await ingestDirectory(ctx, target, `dir:${path.resolve(target)}`, dirLog);
    } else {
      // Single file — ingest its parent-relative name.
      const buf = await fs.readFile(target);
      if (looksBinary(buf)) throw new Error(`${target} looks binary; skipping.`);
      await ingest(ctx, {
        mode: "text",
        text: buf.toString("utf8"),
        name: path.basename(target),
        type_id: 1,
        tags: { source: `file:${path.resolve(target)}` },
      });
      result = { ingested: 1, skipped: 0 };
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\nDone in ${secs}s — ${result.ingested} ingested, ${result.skipped} skipped.\n` +
      `Ask your agent: "search my ingested files for <topic>" or "show my Myco memory stats".`
  );
}

main()
  // Drain background embedding tasks before tearing down — otherwise the
  // process exits mid-embed and the just-imported content is BM25-only (no
  // vector / semantic search) until something re-embeds it.
  .then(() => flushPendingEmbeddings())
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    const msg = (err as Error).message;
    console.error(`\nError: ${msg}`);
    if (/ECONNREFUSED|ENOTFOUND|terminat|timeout/i.test(msg)) {
      console.error(
        `Could not reach the database. Is the stack running?\n` +
          `  docker compose up -d   (from the myco-brain repo root)\n` +
          `Or point DATABASE_URL at your own Postgres.`
      );
    }
    await closePool().catch(() => {});
    process.exit(1);
  });
