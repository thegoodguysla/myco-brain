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
import { ingest } from "./tools/ingest.js";
import { closePool, type SessionContext } from "./db.js";
import {
  SKIP_DIRS,
  MAX_FILE_BYTES,
  isTextFile,
  looksBinary,
  parseGitHubTarget,
} from "./ingest-cli.lib.js";

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function ingestDirectory(
  ctx: SessionContext,
  root: string,
  sourceLabel: string
): Promise<{ ingested: number; skipped: number }> {
  let ingested = 0;
  let skipped = 0;
  for await (const file of walk(root)) {
    if (!isTextFile(file)) {
      skipped++;
      continue;
    }
    let buf: Buffer;
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_FILE_BYTES || stat.size === 0) {
        skipped++;
        continue;
      }
      buf = await fs.readFile(file);
    } catch {
      skipped++;
      continue;
    }
    if (looksBinary(buf)) {
      skipped++;
      continue;
    }
    const text = buf.toString("utf8");
    if (!text.trim()) {
      skipped++;
      continue;
    }
    const rel = path.relative(root, file) || path.basename(file);
    try {
      await ingest(ctx, {
        mode: "text",
        text,
        name: rel,
        type_id: 1,
        tags: { source: sourceLabel, path: rel },
      });
      ingested++;
      console.log(`  + ${rel}`);
    } catch (err) {
      skipped++;
      console.error(`  ! ${rel}: ${(err as Error).message}`);
    }
  }
  return { ingested, skipped };
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
    return await ingestDirectory(ctx, tmp, `github:${repoSlug}`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

function usage(): void {
  console.log(
    `mycobrain-ingest — bulk-ingest a directory or GitHub repo into Brain\n\n` +
      `Usage:\n` +
      `  mycobrain-ingest <path>              # local file or directory (recursive)\n` +
      `  mycobrain-ingest github:owner/repo   # a GitHub repository\n` +
      `  mycobrain-ingest https://github.com/owner/repo\n\n` +
      `Connection (same env as the MCP server):\n` +
      `  DATABASE_URL, BRAIN_WORKSPACE_ID, BRAIN_API_KEY\n` +
      `  GITHUB_TOKEN (optional, for private repos)\n`
  );
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target || target === "-h" || target === "--help") {
    usage();
    process.exit(target ? 0 : 1);
  }

  const auth = resolveAuth({
    apiKey: process.env.BRAIN_API_KEY,
    workspaceId: process.env.BRAIN_WORKSPACE_ID,
    agentId: process.env.BRAIN_AGENT_ID,
  });
  const ctx = await canonicalizeAgentContext(auth.ctx);

  const started = Date.now();
  let result: { ingested: number; skipped: number };

  const repoSlug = parseGitHubTarget(target);
  if (repoSlug) {
    result = await ingestGitHub(ctx, repoSlug);
  } else {
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) throw new Error(`Path not found: ${target}`);
    if (stat.isDirectory()) {
      result = await ingestDirectory(ctx, target, `dir:${path.resolve(target)}`);
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
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`\nError: ${(err as Error).message}`);
    await closePool().catch(() => {});
    process.exit(1);
  });
