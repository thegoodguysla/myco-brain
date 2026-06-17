#!/usr/bin/env node
/**
 * install command check — PURE, no database, no network, no real clients.
 *
 * mycobrain-install's value is correct, idempotent client config. This exercises
 * the pure builders behind it: the shared server entry, the JSON merge (must
 * preserve other servers), the Codex TOML append-if-absent, per-client path
 * resolution across platforms, and that the agent-instructions artifact names
 * the real tools. Importing dist/install.js must NOT run the installer.
 */
const install = await import("../dist/install.js");
const { AGENT_INSTRUCTIONS } = await import("../dist/agent-instructions.js");

let failed = 0;
const ok = (m) => console.log(`ok    ${m}`);
const fail = (m) => {
  failed++;
  console.error(`FAIL  ${m}`);
};
const eq = (a, b, m) => (a === b ? ok(m) : fail(`${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`));
const has = (s, sub, m) => (String(s).includes(sub) ? ok(m) : fail(`${m} — missing ${JSON.stringify(sub)}`));

const OPTS = { databaseUrl: "postgresql://brain:brain@localhost:5432/brain", apiKey: "brain_ws_ag_secret" };

// ── server entry ─────────────────────────────────────────────────────────────
const e = install.serverEntry(OPTS);
eq(e.command, "npx", "serverEntry command is npx");
eq(JSON.stringify(e.args), JSON.stringify(["-y", "@mycobrain/mcp-server"]), "serverEntry args run the package");
eq(e.env.DATABASE_URL, OPTS.databaseUrl, "serverEntry carries DATABASE_URL");
eq(e.env.BRAIN_API_KEY, OPTS.apiKey, "serverEntry carries BRAIN_API_KEY");
eq("BRAIN_WORKSPACE_ID" in e.env, false, "serverEntry omits workspace id by default");
eq(install.serverEntry({ ...OPTS, workspaceId: "ws1" }).env.BRAIN_WORKSPACE_ID, "ws1", "serverEntry includes workspace id when asked");

// ── JSON merge ───────────────────────────────────────────────────────────────
const fresh = JSON.parse(install.mergeMcpServers(null, OPTS));
has(JSON.stringify(fresh), "myco-brain", "merge into empty creates the myco-brain server");
eq(fresh.mcpServers["myco-brain"].command, "npx", "fresh merge has correct command");

const withOther = JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" });
const merged = JSON.parse(install.mergeMcpServers(withOther, OPTS));
eq(merged.mcpServers.other.command, "x", "merge preserves an existing OTHER server");
eq(merged.theme, "dark", "merge preserves unrelated top-level keys");
has(JSON.stringify(merged.mcpServers["myco-brain"]), "BRAIN_API_KEY", "merge adds our server with env");

let threw = false;
try {
  install.mergeMcpServers("{ not json", OPTS);
} catch {
  threw = true;
}
eq(threw, true, "merge throws on invalid existing JSON (never clobbers blindly)");

// ── Codex TOML ───────────────────────────────────────────────────────────────
const codexFresh = install.buildCodexToml(null, OPTS);
eq(codexFresh.changed, true, "codex: writes into an empty file");
has(codexFresh.text, "[mcp_servers.myco-brain]", "codex: emits the mcp_servers table");
has(codexFresh.text, "[mcp_servers.myco-brain.env]", "codex: emits the env subtable");
has(codexFresh.text, "DATABASE_URL", "codex: env carries DATABASE_URL");

const codexAppend = install.buildCodexToml('[other]\nx = 1\n', OPTS);
eq(codexAppend.changed, true, "codex: appends when our block is absent");
has(codexAppend.text, "[other]", "codex: append preserves existing tables");

const codexIdempotent = install.buildCodexToml(codexFresh.text, OPTS);
eq(codexIdempotent.changed, false, "codex: idempotent — leaves an existing block untouched");

// ── per-client path resolution ───────────────────────────────────────────────
const mac = { platform: "darwin", home: "/Users/x", cwd: "/repo", scope: "user" };
const win = { platform: "win32", home: "C:\\Users\\x", appData: "C:\\Users\\x\\AppData\\Roaming", cwd: "C:\\repo", scope: "user" };
const lin = { platform: "linux", home: "/home/x", cwd: "/repo", scope: "user" };

has(install.resolveClientPath("claude-desktop", mac), "Library/Application Support/Claude/claude_desktop_config.json", "claude-desktop path (mac)");
has(install.resolveClientPath("claude-desktop", lin), "/.config/Claude/claude_desktop_config.json", "claude-desktop path (linux)");
// node:path.join uses the HOST separator, so on a posix CI host the win32 path
// has forward slashes — assert the branch picked the %APPDATA%\Claude location,
// separator-agnostically. On real Windows the separators come out native.
const winPath = install.resolveClientPath("claude-desktop", win);
has(winPath, "Roaming", "claude-desktop path (win) is under APPDATA/Roaming");
has(winPath, "Claude", "claude-desktop path (win) is under Claude");
has(winPath, "claude_desktop_config.json", "claude-desktop path (win) names the config file");
has(install.resolveClientPath("cursor", mac), "/.cursor/mcp.json", "cursor user path");
eq(install.resolveClientPath("cursor", { ...mac, scope: "project" }), "/repo/.cursor/mcp.json", "cursor project path uses cwd");
has(install.resolveClientPath("windsurf", mac), "/.codeium/windsurf/mcp_config.json", "windsurf path");
has(install.resolveClientPath("codex", mac), "/.codex/config.toml", "codex path");
eq(install.resolveClientPath("claude-code", mac), "/repo/.mcp.json", "claude-code fallback path is project .mcp.json");

// ── print snippets ───────────────────────────────────────────────────────────
has(install.printSnippet("zed", OPTS).body, "context_servers", "zed snippet uses context_servers");
has(install.printSnippet("continue", OPTS).body, "mcpServers:", "continue snippet is yaml mcpServers");
has(install.printSnippet("generic", OPTS).body, "mcpServers", "generic snippet is mcpServers json");

// ── agent instructions name the real tools ───────────────────────────────────
for (const tool of ["brain_context_pack", "brain_save_memory", "brain_recall_memory", "brain_why", "brain_search"]) {
  has(AGENT_INSTRUCTIONS, tool, `agent instructions reference ${tool}`);
}

console.log(failed === 0 ? "\n=== PASS (install) ===" : `\n=== FAIL (${failed}) ===`);
process.exit(failed === 0 ? 0 : 1);
