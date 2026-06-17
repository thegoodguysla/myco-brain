#!/usr/bin/env node
/**
 * mycobrain-install — connect your agent in one command.
 *
 * Standing up the stack is one thing; the part that's actually fiddly today is
 * wiring each client's MCP config by hand (a long `claude mcp add`, or editing
 * claude_desktop_config.json / .cursor/mcp.json / ~/.codex/config.toml). This
 * command does that for you, idempotently, and then prints the paste-anywhere
 * agent instructions so the agent actually USES the memory.
 *
 *   mycobrain-install                  detect installed clients and wire them
 *   mycobrain-install --client cursor  wire one specific client
 *   mycobrain-install --all            wire every auto-supported client
 *   mycobrain-install --print          just print the config + agent instructions
 *
 * Flags:
 *   --client <name>   claude-code | claude-desktop | cursor | windsurf | codex
 *                     (zed | continue | cline are print-only — emitted as a snippet)
 *   --all             wire every auto-write client
 *   --print           print snippets/instructions, write nothing
 *   --scope user|project   where to write (default: user; project for cwd-local)
 *   --db-url <url>    DATABASE_URL (default: quickstart localdev)
 *   --api-key <key>   BRAIN_API_KEY (default: quickstart localdev)
 *   --workspace-id <id>  include BRAIN_WORKSPACE_ID (optional; derived from key)
 *   --no-verify       skip the "is the stack reachable?" check
 *   --yes             non-interactive: wire all detected clients without asking
 *
 * Connection defaults to the docker-compose quickstart stack on localhost — the
 * same seeded, public localdev credentials the rest of the CLI uses.
 */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { AGENT_INSTRUCTIONS, DEFAULT_SERVER_NAME } from "./agent-instructions.js";

export const LOCALDEV_DATABASE_URL = "postgresql://brain:brain@localhost:5432/brain";
export const LOCALDEV_API_KEY =
  "brain_00000000-0000-0000-0000-000000000001_00000000-0000-0000-0000-0000000000a1_localdev";
export const SERVER_NAME = DEFAULT_SERVER_NAME;

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

export interface InstallOpts {
  databaseUrl: string;
  apiKey: string;
  workspaceId?: string;
}

// The canonical MCP server entry every JSON-based client shares: run the
// published package over stdio with the connection env. Workspace id is omitted
// by default (the brain_ API key encodes it) and only set when asked.
export function serverEntry(opts: InstallOpts): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const env: Record<string, string> = {
    DATABASE_URL: opts.databaseUrl,
    BRAIN_API_KEY: opts.apiKey,
  };
  if (opts.workspaceId) env.BRAIN_WORKSPACE_ID = opts.workspaceId;
  return { command: "npx", args: ["-y", "@mycobrain/mcp-server"], env };
}

export type ClientKind = "cli-claude" | "json" | "toml" | "print";

export interface ClientDef {
  key: string;
  label: string;
  kind: ClientKind;
  // Resolve the config file path. ctx carries platform + home so it is testable.
  path?: (ctx: PathCtx) => string;
  // For detection: a path whose existence implies the client is installed.
  detect?: (ctx: PathCtx) => string;
}

export interface PathCtx {
  platform: NodeJS.Platform;
  home: string;
  appData?: string;
  cwd: string;
  scope: "user" | "project";
}

export const CLIENTS: ClientDef[] = [
  {
    key: "claude-code",
    label: "Claude Code",
    kind: "cli-claude",
    // Fallback when the `claude` CLI is absent: a project-local .mcp.json.
    path: (c) => join(c.cwd, ".mcp.json"),
    detect: (c) => join(c.home, ".claude"),
  },
  {
    key: "claude-desktop",
    label: "Claude Desktop",
    kind: "json",
    path: (c) =>
      c.platform === "darwin"
        ? join(c.home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : c.platform === "win32"
          ? join(c.appData ?? join(c.home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
          : join(c.home, ".config", "Claude", "claude_desktop_config.json"),
    detect: (c) =>
      c.platform === "darwin"
        ? join(c.home, "Library", "Application Support", "Claude")
        : c.platform === "win32"
          ? join(c.appData ?? join(c.home, "AppData", "Roaming"), "Claude")
          : join(c.home, ".config", "Claude"),
  },
  {
    key: "cursor",
    label: "Cursor",
    kind: "json",
    path: (c) => (c.scope === "project" ? join(c.cwd, ".cursor", "mcp.json") : join(c.home, ".cursor", "mcp.json")),
    detect: (c) => join(c.home, ".cursor"),
  },
  {
    key: "windsurf",
    label: "Windsurf",
    kind: "json",
    path: (c) => join(c.home, ".codeium", "windsurf", "mcp_config.json"),
    detect: (c) => join(c.home, ".codeium", "windsurf"),
  },
  {
    key: "codex",
    label: "Codex",
    kind: "toml",
    path: (c) => join(c.home, ".codex", "config.toml"),
    detect: (c) => join(c.home, ".codex"),
  },
  { key: "zed", label: "Zed", kind: "print", detect: (c) => join(c.home, ".config", "zed") },
  { key: "continue", label: "Continue", kind: "print", detect: (c) => join(c.home, ".continue") },
  { key: "cline", label: "Cline", kind: "print" },
];

export function findClient(key: string): ClientDef | undefined {
  return CLIENTS.find((c) => c.key === key);
}

export function resolveClientPath(key: string, ctx: PathCtx): string | null {
  const def = findClient(key);
  return def?.path ? def.path(ctx) : null;
}

// ── JSON clients (Claude Desktop / Cursor / Windsurf / Claude Code fallback) ──
// Merge our server under mcpServers, preserving every other server and key. Pure
// and string-in/string-out so it is unit-testable without touching the disk.
export function mergeMcpServers(existingText: string | null, opts: InstallOpts): string {
  let root: Record<string, unknown> = {};
  if (existingText && existingText.trim()) {
    const parsed = JSON.parse(existingText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      root = parsed as Record<string, unknown>;
    } else {
      throw new Error("existing config is not a JSON object");
    }
  }
  const servers =
    root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)
      ? (root.mcpServers as Record<string, unknown>)
      : {};
  servers[SERVER_NAME] = serverEntry(opts);
  root.mcpServers = servers;
  return JSON.stringify(root, null, 2) + "\n";
}

// ── Codex (~/.codex/config.toml) ─────────────────────────────────────────────
// Codex reads MCP servers from a [mcp_servers.<name>] TOML table. We have no TOML
// dependency, so this is a safe append-if-absent: if our block already exists we
// leave the file untouched and report changed=false (the caller prints the block
// so the user can reconcile by hand).
export function codexBlock(opts: InstallOpts): string {
  const e = serverEntry(opts);
  const args = e.args.map((a) => JSON.stringify(a)).join(", ");
  const lines = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${JSON.stringify(e.command)}`,
    `args = [${args}]`,
    ``,
    `[mcp_servers.${SERVER_NAME}.env]`,
  ];
  for (const [k, v] of Object.entries(e.env)) lines.push(`${k} = ${JSON.stringify(v)}`);
  return lines.join("\n") + "\n";
}

export function buildCodexToml(
  existingText: string | null,
  opts: InstallOpts
): { text: string; changed: boolean } {
  const block = codexBlock(opts);
  if (existingText && new RegExp(`\\[mcp_servers\\.${SERVER_NAME}\\b`).test(existingText)) {
    return { text: existingText, changed: false };
  }
  if (!existingText || !existingText.trim()) return { text: block, changed: true };
  const sep = existingText.endsWith("\n") ? "\n" : "\n\n";
  return { text: existingText + sep + block, changed: true };
}

// ── Print-only clients (Zed / Continue / Cline / generic) ────────────────────
// Their config schemas are version-volatile enough that auto-writing risks
// clobbering, so we hand over a ready snippet and the file to paste it into.
export function printSnippet(key: string, opts: InstallOpts): { hint: string; body: string } {
  const e = serverEntry(opts);
  const json = JSON.stringify({ mcpServers: { [SERVER_NAME]: e } }, null, 2);
  if (key === "zed") {
    const body = JSON.stringify(
      { context_servers: { [SERVER_NAME]: { command: e.command, args: e.args, env: e.env } } },
      null,
      2
    );
    return { hint: "Zed — add under context_servers in ~/.config/zed/settings.json (shape varies by Zed version):", body };
  }
  if (key === "continue") {
    const body =
      `mcpServers:\n` +
      `  - name: ${SERVER_NAME}\n` +
      `    command: ${e.command}\n` +
      `    args: [${e.args.map((a) => JSON.stringify(a)).join(", ")}]\n` +
      `    env:\n` +
      Object.entries(e.env)
        .map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`)
        .join("\n") +
      `\n`;
    return { hint: "Continue — add to ~/.continue/config.yaml:", body };
  }
  if (key === "cline") {
    return { hint: "Cline — open the MCP Servers panel → Configure, then add to cline_mcp_settings.json:", body: json };
  }
  return { hint: "Any MCP client — add this mcpServers block to its config:", body: json };
}

// Side-effecting write of a JSON-client config: back up an existing file, ensure
// the directory exists, and write the merged result.
function writeJsonClient(path: string, opts: InstallOpts): { action: "created" | "updated" } {
  const existed = existsSync(path);
  const existing = existed ? readFileSync(path, "utf8") : null;
  let merged: string;
  try {
    merged = mergeMcpServers(existing, opts);
  } catch (err) {
    throw new Error(
      `${path} exists but is not valid JSON (${(err as Error).message}). ` +
        `Fix or remove it, or re-run with --print and paste the block by hand.`
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  if (existed && existing !== merged) writeFileSync(path + ".bak", existing ?? "");
  writeFileSync(path, merged);
  return { action: existed ? "updated" : "created" };
}

function writeCodex(path: string, opts: InstallOpts): { changed: boolean } {
  const existed = existsSync(path);
  const existing = existed ? readFileSync(path, "utf8") : null;
  const { text, changed } = buildCodexToml(existing, opts);
  if (!changed) return { changed: false };
  mkdirSync(dirname(path), { recursive: true });
  if (existed) writeFileSync(path + ".bak", existing ?? "");
  writeFileSync(path, text);
  return { changed: true };
}

function hasClaudeCli(): boolean {
  const r = spawnSync("claude", ["--version"], { stdio: "ignore" });
  return !r.error && r.status === 0;
}

function runClaudeAdd(opts: InstallOpts, scope: "user" | "project"): boolean {
  const args = [
    "mcp",
    "add",
    SERVER_NAME,
    "--scope",
    scope === "user" ? "user" : "local",
    "--env",
    `DATABASE_URL=${opts.databaseUrl}`,
    "--env",
    `BRAIN_API_KEY=${opts.apiKey}`,
  ];
  if (opts.workspaceId) args.push("--env", `BRAIN_WORKSPACE_ID=${opts.workspaceId}`);
  args.push("--", "npx", "-y", "@mycobrain/mcp-server");
  const r = spawnSync("claude", args, { stdio: "inherit" });
  return !r.error && r.status === 0;
}

// Wire a single client. Returns a human line describing what happened.
function installClient(key: string, opts: InstallOpts, ctx: PathCtx): string {
  const def = findClient(key);
  if (!def) return `${C.red("✗")} ${key} ${C.dim("— unknown client")}`;

  if (def.kind === "cli-claude") {
    if (hasClaudeCli()) {
      const ok = runClaudeAdd(opts, ctx.scope);
      return ok
        ? `${C.green("✓")} ${def.label} ${C.dim("— added via `claude mcp add` (restart Claude Code)")}`
        : `${C.yellow("!")} ${def.label} ${C.dim("— `claude mcp add` failed; falling back to .mcp.json")}` +
            "\n  " +
            installJsonAt(def.path!(ctx), opts, def.label);
    }
    return installJsonAt(def.path!(ctx), opts, def.label) + C.dim("  (claude CLI not found; wrote project .mcp.json)");
  }

  if (def.kind === "json") return installJsonAt(def.path!(ctx), opts, def.label);

  if (def.kind === "toml") {
    const path = def.path!(ctx);
    const { changed } = writeCodex(path, opts);
    if (changed) return `${C.green("✓")} ${def.label} ${C.dim(`— wrote ${tilde(path, ctx)} (restart Codex)`)}`;
    return (
      `${C.yellow("!")} ${def.label} ${C.dim(`— ${tilde(path, ctx)} already has a ${SERVER_NAME} entry; left it untouched.`)}` +
      `\n  ${C.dim("Edit it by hand if the connection details changed.")}`
    );
  }

  // print-only
  const { hint, body } = printSnippet(def.key, opts);
  return `${C.cyan("›")} ${def.label} ${C.dim("— print-only:")}\n  ${C.dim(hint)}\n${indent(body, 2)}`;
}

function installJsonAt(path: string, opts: InstallOpts, label: string): string {
  try {
    const { action } = writeJsonClient(path, opts);
    return `${C.green("✓")} ${label} ${C.dim(`— ${action} ${path}`)}`;
  } catch (err) {
    return `${C.red("✗")} ${label} ${C.dim(`— ${(err as Error).message}`)}`;
  }
}

function tilde(path: string, ctx: PathCtx): string {
  return path.startsWith(ctx.home) ? "~" + path.slice(ctx.home.length) : path;
}
function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((l) => (l ? pad + l : l))
    .join("\n");
}

// Quick "is the stack up?" check. Imported lazily so the pure exports above stay
// dependency-light and the unit test never needs a database.
async function verifyStack(databaseUrl: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const pg = (await import("pg")).default;
    const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 2500 });
    await client.connect();
    await client.query("SELECT 1");
    await client.end().catch(() => {});
    return { ok: true, detail: "stack reachable" };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

function detectInstalled(ctx: PathCtx): ClientDef[] {
  return CLIENTS.filter((c) => c.detect && existsSync(c.detect(ctx)) && c.kind !== "print");
}

function parseArgs(argv: string[]): {
  client?: string;
  all: boolean;
  print: boolean;
  scope: "user" | "project";
  yes: boolean;
  verify: boolean;
  opts: InstallOpts;
} {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const databaseUrl = get("--db-url") || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || LOCALDEV_DATABASE_URL;
  const apiKey = get("--api-key") || process.env.BRAIN_API_KEY || LOCALDEV_API_KEY;
  const workspaceId = get("--workspace-id") || process.env.BRAIN_WORKSPACE_ID;
  return {
    client: get("--client"),
    all: argv.includes("--all"),
    print: argv.includes("--print"),
    scope: get("--scope") === "project" ? "project" : "user",
    yes: argv.includes("--yes") || argv.includes("-y"),
    verify: !argv.includes("--no-verify"),
    opts: { databaseUrl, apiKey, workspaceId },
  };
}

function printAgentInstructions(): void {
  console.log("");
  console.log(`  ${C.bold("Copy these agent instructions")} ${C.dim("(paste into CLAUDE.md / .cursorrules / AGENTS.md / system prompt):")}`);
  console.log("");
  console.log(indent(AGENT_INSTRUCTIONS, 2));
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const ctx: PathCtx = {
    platform: osPlatform(),
    home: homedir(),
    appData: process.env.APPDATA,
    cwd: process.cwd(),
    scope: a.scope,
  };

  console.log(`\n  ${C.bold("🧠 Myco Brain — connect your agent")}\n`);

  if (a.print) {
    const { hint, body } = printSnippet(a.client ?? "generic", a.opts);
    console.log(`  ${C.dim(hint)}`);
    console.log(indent(body, 2));
    printAgentInstructions();
    return;
  }

  // Which clients?
  let targets: ClientDef[];
  if (a.client) {
    const def = findClient(a.client);
    if (!def) {
      console.error(`  ${C.red("Unknown client:")} ${a.client}`);
      console.error(`  Known: ${CLIENTS.map((c) => c.key).join(", ")}\n`);
      process.exit(1);
    }
    targets = [def];
  } else if (a.all) {
    targets = CLIENTS.filter((c) => c.kind !== "print");
  } else {
    targets = detectInstalled(ctx);
    if (targets.length === 0) {
      console.log(`  ${C.yellow("No installed clients detected.")} Choose one explicitly, e.g.:`);
      console.log(`    ${C.green("mycobrain-install --client cursor")}`);
      console.log(`  Or print a snippet for any client:  ${C.green("mycobrain-install --print")}\n`);
      printAgentInstructions();
      return;
    }
    console.log(`  ${C.dim(`Detected: ${targets.map((t) => t.label).join(", ")}`)}\n`);
  }

  // Wire them.
  for (const def of targets) console.log("  " + installClient(def.key, a.opts, ctx));

  // Is the stack actually up?
  let stackOk = false;
  if (a.verify) {
    const usingLocaldev = a.opts.databaseUrl === LOCALDEV_DATABASE_URL;
    const v = await verifyStack(a.opts.databaseUrl);
    stackOk = v.ok;
    console.log("");
    if (v.ok) {
      console.log(`  ${C.green("✓")} ${C.bold("Stack")} ${C.dim("— reachable.")}`);
    } else {
      console.log(`  ${C.yellow("!")} ${C.bold("Stack")} ${C.dim("— not reachable yet.")}`);
      console.log(
        usingLocaldev
          ? `    ${C.dim("Start it:")} ${C.green("docker compose up -d")} ${C.dim("(from the myco-brain repo, or ./quickstart.sh)")}`
          : `    ${C.dim("Check DATABASE_URL points at a running Postgres.")}`
      );
    }
  }

  // All-in-one: when the stack is up and we're interactive, run the onboarding
  // demo now (index this repo, prove recall). --onboard forces it, --no-onboard
  // skips. Non-interactive runs (CI, piped) default to skip and print the CTA.
  const forceOnboard = process.argv.includes("--onboard");
  const skipOnboard = process.argv.includes("--no-onboard");
  const runOnboard = !skipOnboard && (forceOnboard || (stackOk && !!process.stdout.isTTY));

  if (runOnboard) {
    console.log("");
    console.log(`  ${C.dim("Agent instructions are sent to your client automatically; full copy:")} ${C.green("mycobrain-install --print")}`);
    const onboardPath = join(dirname(fileURLToPath(import.meta.url)), "onboard.js");
    const childEnv: Record<string, string> = {
      ...process.env,
      DATABASE_URL: a.opts.databaseUrl,
      BRAIN_API_KEY: a.opts.apiKey,
    };
    if (a.opts.workspaceId) childEnv.BRAIN_WORKSPACE_ID = a.opts.workspaceId;
    // No --demo: let onboard decide (empty brain -> the index-this-repo aha;
    // a brain with memories -> the getting-started guide), so a returning user
    // is not force-fed a demo that recalls unrelated existing content.
    const r = spawnSync(process.execPath, [onboardPath], { stdio: "inherit", env: childEnv });
    if (r.error) {
      printAgentInstructions();
      console.log("");
      console.log(`  ${C.dim("Next: index this project →")} ${C.green("mycobrain-onboard")}`);
      console.log("");
    }
  } else {
    printAgentInstructions();
    console.log("");
    console.log(`  ${C.dim("Next: index this project →")} ${C.green("mycobrain-onboard")}`);
    console.log("");
  }
}

// Only run main() when invoked as a binary — importing this module (the unit
// test does) must not trigger the installer. Compare REAL paths: npm installs the
// bin as a symlink, so process.argv[1] is the symlink and import.meta.url is the
// real file; without realpath they never match and main() would never run.
const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`\ninstall failed: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
