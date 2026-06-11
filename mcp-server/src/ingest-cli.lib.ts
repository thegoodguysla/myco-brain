/**
 * Pure, side-effect-free helpers for mycobrain-ingest.
 * Kept separate from ingest-cli.ts (which connects to the DB and self-executes)
 * so the file-selection and target-parsing logic can be unit-tested.
 */
import * as path from "node:path";

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
export function parseGitHubTarget(target: string): string | null {
  if (target.startsWith("github:")) {
    const slug = target.slice("github:".length).replace(/\.git$/, "");
    return /^[^/]+\/[^/]+$/.test(slug) ? slug : null;
  }
  const m = target.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  return m ? m[1] : null;
}
