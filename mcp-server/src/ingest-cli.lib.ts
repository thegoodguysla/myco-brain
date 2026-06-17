/**
 * Helpers for mycobrain-ingest. The file-selection / target-parsing logic is
 * pure and unit-tested; walk()/ingestDirectory() live here too so onboard.ts can
 * reuse the directory-ingest in-process (ingest-cli.ts self-executes on import,
 * so it can't be imported from directly).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ingest } from "./tools/ingest.js";
import type { SessionContext } from "./db.js";

// Text-like file extensions worth ingesting. Anything else is skipped.
export const TEXT_EXTS = new Set([
  ".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".cc", ".cpp",
  ".h", ".hpp", ".cs", ".php", ".scala", ".clj", ".ex", ".exs", ".erl",
  ".lua", ".r", ".jl", ".dart", ".sh", ".bash", ".zsh", ".ps1",
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".vue", ".svelte",
  ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".properties",
  ".sql", ".graphql", ".gql", ".proto", ".csv", ".tsv", ".tex",
]);

// Files worth ingesting even without a matching extension.
export const TEXT_BASENAMES = new Set([
  "Dockerfile", "Makefile", "README", "LICENSE", "CHANGELOG", "CONTRIBUTING",
  ".env.example", ".gitignore",
]);

// Directories never worth walking.
export const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "vendor",
  "target", ".venv", "venv", "__pycache__", ".cache", "coverage",
  ".turbo", ".vercel", ".idea", ".vscode",
]);

export const MAX_FILE_BYTES = 1_000_000; // skip anything larger than ~1 MB

export function isTextFile(filePath: string): boolean {
  const base = path.basename(filePath);
  if (TEXT_BASENAMES.has(base)) return true;
  return TEXT_EXTS.has(path.extname(filePath).toLowerCase());
}

export function looksBinary(buf: Buffer): boolean {
  // A NUL byte in the first chunk is a strong signal the file is binary.
  return buf.subarray(0, 8000).includes(0);
}

/**
 * Parse a GitHub target into an "owner/repo" slug, or null if not a GitHub
 * target. Accepts `github:owner/repo` and `https://github.com/owner/repo`
 * (with optional `.git` and trailing path).
 */
export type ExportKind = "chatgpt-export" | "claude-export";

// Identify a ChatGPT vs Claude data export from the file names inside its zip.
// Neither vendor offers an import API, so the export zip (dragged or auto-detected
// from ~/Downloads) is the real path. Distinguishing files: ChatGPT ships
// chat.html / message_feedback.json / model_comparisons.json / user.json; Claude
// ships projects.json / users.json. Returns null when it's neither, or ambiguous.
export function detectExportKind(entryNames: string[]): ExportKind | null {
  const base = new Set(entryNames.map((n) => n.split("/").pop() || n));
  const chatgpt = ["chat.html", "message_feedback.json", "model_comparisons.json", "user.json"].some((f) => base.has(f));
  const claude = ["projects.json", "users.json"].some((f) => base.has(f));
  if (chatgpt && !claude) return "chatgpt-export";
  if (claude && !chatgpt) return "claude-export";
  // Last resort: a bare conversations.json (no distinguishing files) is most
  // commonly a ChatGPT export.
  if (!chatgpt && !claude && base.has("conversations.json")) return "chatgpt-export";
  return null;
}

export function parseGitHubTarget(target: string): string | null {
  if (target.startsWith("github:")) {
    const slug = target.slice("github:".length).replace(/\.git$/, "");
    return /^[^/]+\/[^/]+$/.test(slug) ? slug : null;
  }
  const m = target.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  return m ? m[1] : null;
}

// Recursively yield every file path under dir, skipping SKIP_DIRS.
export async function* walk(dir: string): AsyncGenerator<string> {
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

export interface IngestDirOptions {
  // Called with the repo-relative path after each successful ingest. ingest-cli
  // prints these; onboard uses it as a quiet progress counter.
  onFile?: (rel: string) => void;
  onError?: (rel: string, message: string) => void;
  // Stop after this many successful ingests (keeps onboarding snappy on a big
  // repo). When hit, `capped` is true so the caller can point at mycobrain-ingest
  // for the rest. Omit for an unbounded walk (the CLI default).
  maxFiles?: number;
}

export interface IngestDirResult {
  ingested: number;
  skipped: number;
  capped: boolean;
}

// Walk a directory and ingest every text file via brain_ingest (text mode), so
// it is chunked + full-text indexed immediately. Content-hash dedup makes a
// re-run a no-op. Connection/auth ride on the passed SessionContext.
export async function ingestDirectory(
  ctx: SessionContext,
  root: string,
  sourceLabel: string,
  opts: IngestDirOptions = {}
): Promise<IngestDirResult> {
  let ingested = 0;
  let skipped = 0;
  for await (const file of walk(root)) {
    if (opts.maxFiles !== undefined && ingested >= opts.maxFiles) {
      return { ingested, skipped, capped: true };
    }
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
      opts.onFile?.(rel);
    } catch (err) {
      skipped++;
      opts.onError?.(rel, (err as Error).message);
    }
  }
  return { ingested, skipped, capped: false };
}
