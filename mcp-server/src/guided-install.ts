#!/usr/bin/env node
/**
 * mycobrain-setup — the guided, self-healing install.
 *
 * The cryptic fresh-machine failure (no Docker / no prereq -> stack trace) is
 * what made Myco feel un-installable for a non-technical user. This replaces it
 * with a consent-driven walkthrough that says what's needed, offers to fix it,
 * wires each client, verifies the connection actually works (pgvector + a real
 * write), offers to import your ChatGPT/Claude history, and ends green.
 *
 * Nine steps; a non-technical user answers ~5 y/n. Experts skip the asking:
 *   mycobrain-setup --yes              accept safe defaults, no prompts
 *   mycobrain-setup --all              wire every auto-supported client
 *   mycobrain-setup --client cursor    wire one specific client
 *   mycobrain-setup --no-import        skip the history-import offer
 *   mycobrain-setup --db-url <url>     point at your own Postgres
 *   mycobrain-setup --api-key <key>    BRAIN_API_KEY
 *
 * The flow is a step machine: each step is a pure `(deps, ctx) => StepResult`
 * with ALL its I/O (prompts, machine probes, DB probe, client wiring, zip scan,
 * doctor) injected, so the whole orchestrator is unit-testable with no terminal,
 * no database, and no real export on disk. main() wires the real implementations.
 */
import "dotenv/config";
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import {
  CLIENTS,
  detectInstalled,
  findClient,
  installClient,
  LOCALDEV_API_KEY,
  LOCALDEV_DATABASE_URL,
  type ClientDef,
  type InstallOpts,
  type PathCtx,
} from "./install.js";
import {
  checkPrerequisites,
  checkDatabase,
  summarize,
  realProbes,
  type DbProbe,
  type PreflightProbes,
} from "./preflight.js";
import {
  scanForExport,
  describeCandidate,
  providerLabel,
  type ExportCandidate,
  type ScanIo,
} from "./history-import.lib.js";
import { provisionClientAgent, supportsPerClientAgent } from "./client-agent.js";
import { AGENT_INSTRUCTIONS } from "./agent-instructions.js";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

// ── Injected boundaries (everything the steps touch outside pure logic) ──────

/** Terminal I/O — confirm() returns `def` when there's no TTY (or under test). */
export interface Io {
  print(line?: string): void;
  confirm(question: string, def: boolean): Promise<boolean>;
}

/** Result of the live DB probe used by the verify step. */
export interface DbProbeResult extends DbProbe {
  reachable: boolean;
  error?: string;
}

export interface GuidedFlags {
  yes: boolean;
  all: boolean;
  client?: string;
  /** --import forces the history offer to proceed; --no-import skips it. */
  forceImport: boolean;
  noImport: boolean;
  /** Give each client its OWN agent identity (provenance by tool). Default true;
   *  --shared-agent opts every client into one shared identity instead. */
  separateAgents: boolean;
}

export interface GuidedDeps {
  io: Io;
  probes: PreflightProbes;
  /** Which clients are installed (default: detectInstalled). */
  detect: (ctx: PathCtx) => ClientDef[];
  /** Wire one client; returns a human line (default: installClient). */
  wire: (key: string, opts: InstallOpts, ctx: PathCtx) => string;
  /** Live DB probe for the verify step. */
  dbProbe: (databaseUrl: string) => Promise<DbProbeResult>;
  /** Scan a folder for an importable export (default: real unzip-backed scan). */
  scanIo: ScanIo;
  /** The folder to scan for exports (default: ~/Downloads). */
  downloadsDir: string;
  /** Actually import a detected export (default: shell to mycobrain-ingest). */
  runImport: (cand: ExportCandidate, opts: InstallOpts) => Promise<{ ok: boolean; detail: string }>;
  /** Run the doctor self-heal (default: shell to mycobrain-doctor). */
  runDoctor: (opts: InstallOpts, fix: boolean) => { ok: boolean };
  /** Mint a per-client agent + key; returns per-client opts, or null to fall
   *  back to the shared key (non-brain key, DB unreachable, or mint failed). */
  provisionAgent: (clientKey: string, opts: InstallOpts) => Promise<InstallOpts | null>;
}

export interface GuidedCtx {
  opts: InstallOpts;
  pathCtx: PathCtx;
  flags: GuidedFlags;
  // accumulated across steps
  targets: ClientDef[];
  wired: string[];
  preflightOk: boolean;
  dbReachable: boolean;
  pgvector: boolean;
  importedCount?: number;
}

export interface StepResult {
  ok: boolean;
  /** Stop the whole flow (user declined to continue, or a fatal problem). */
  halt?: boolean;
}

export interface GuidedSummary {
  completed: boolean;
  stoppedAt?: string;
  wired: string[];
  dbReachable: boolean;
  importedCount?: number;
}

type Step = (deps: GuidedDeps, ctx: GuidedCtx) => Promise<StepResult>;

// ── Step 0: prerequisites (the install self-heal) ────────────────────────────
export const stepPrerequisites: Step = async (deps, ctx) => {
  const checks = await checkPrerequisites(deps.probes, {
    dbPort: dbPortOf(ctx.opts.databaseUrl),
    // Phase 1 always CONNECTS to a pre-existing Postgres (quickstart stack or
    // BYO) — it never binds the port itself. So an occupied port is the healthy
    // state, and a free one is the thing to warn about ("start the stack").
    expectStackPort: true,
  });
  const s = summarize(checks);
  deps.io.print();
  deps.io.print(`  ${C.bold("1/9  Checking prerequisites")}`);
  for (const line of s.lines) deps.io.print("    " + colorizeCheck(line));
  ctx.preflightOk = s.ok;
  if (!s.ok) {
    deps.io.print();
    const go = ctx.flags.yes || (await deps.io.confirm(`  ${C.yellow("Some checks failed.")} Continue anyway?`, false));
    if (!go) return { ok: false, halt: true };
  }
  return { ok: s.ok };
};

// ── Step 1: connection consent ───────────────────────────────────────────────
export const stepConnectionConsent: Step = async (deps, ctx) => {
  const usingLocaldev = ctx.opts.databaseUrl === LOCALDEV_DATABASE_URL;
  deps.io.print();
  deps.io.print(`  ${C.bold("2/9  Connection")}`);
  deps.io.print(`    ${C.dim("database:")} ${describeDatabase(ctx.opts.databaseUrl)}${usingLocaldev ? C.dim("  (quickstart stack)") : ""}`);
  deps.io.print(`    ${C.dim("api key: ")} ${maskKey(ctx.opts.apiKey)}`);
  const go = ctx.flags.yes || (await deps.io.confirm(`  Connect Myco using this?`, true));
  if (!go) {
    deps.io.print();
    deps.io.print(`  ${C.dim("No problem — re-run with")} ${C.green("mycobrain-setup --db-url <url> --api-key <key>")} ${C.dim("to use your own.")}`);
    return { ok: false, halt: true };
  }
  // Provenance-by-tool: each client gets its OWN agent identity by default, so a
  // memory written in Cursor shows as Cursor when recalled in Claude. Only ask
  // interactively (--yes/--shared-agent decide it without a prompt), and only
  // when the key can carry a per-agent identity.
  if (supportsPerClientAgent(ctx.opts.apiKey) && !ctx.flags.yes && ctx.flags.separateAgents) {
    ctx.flags.separateAgents = await deps.io.confirm(
      `  Give each app its own memory identity ${C.dim("(see which app a memory came from)")}?`,
      true
    );
  }
  return { ok: true };
};

// ── Step 2: client detection ─────────────────────────────────────────────────
export const stepClientDetection: Step = async (deps, ctx) => {
  deps.io.print();
  deps.io.print(`  ${C.bold("3/9  Finding your agents")}`);
  if (ctx.flags.client) {
    const def = findClient(ctx.flags.client);
    if (!def) {
      deps.io.print(`    ${C.red("✗")} unknown client "${ctx.flags.client}" ${C.dim(`— known: ${CLIENTS.map((c) => c.key).join(", ")}`)}`);
      return { ok: false, halt: true };
    }
    ctx.targets = [def];
  } else if (ctx.flags.all) {
    ctx.targets = CLIENTS.filter((c) => c.kind !== "print");
  } else {
    ctx.targets = deps.detect(ctx.pathCtx);
  }
  if (ctx.targets.length === 0) {
    deps.io.print(`    ${C.yellow("No installed agents detected.")}`);
    deps.io.print(`    ${C.dim("Wire one explicitly:")} ${C.green("mycobrain-setup --client cursor")} ${C.dim("· or all:")} ${C.green("--all")}`);
  } else {
    deps.io.print(`    ${C.dim("Detected:")} ${ctx.targets.map((t) => t.label).join(", ")}`);
  }
  return { ok: true };
};

// ── Step 3: per-client consent ───────────────────────────────────────────────
export const stepPerClientConsent: Step = async (deps, ctx) => {
  deps.io.print();
  deps.io.print(`  ${C.bold("4/9  Which agents to connect")}`);
  if (ctx.targets.length === 0) {
    deps.io.print(`    ${C.dim("None detected — skipping.")}`);
    return { ok: true };
  }
  // An explicit selection (--client / --all) or --yes IS the consent; only the
  // default "we auto-detected these" path asks per client.
  const autoConsent = ctx.flags.yes || ctx.flags.all || !!ctx.flags.client;
  if (autoConsent) {
    deps.io.print(`    ${C.dim("Connecting:")} ${ctx.targets.map((t) => t.label).join(", ")}`);
    return { ok: true };
  }
  const keep: ClientDef[] = [];
  for (const def of ctx.targets) {
    if (await deps.io.confirm(`    Connect ${C.bold(def.label)}?`, true)) keep.push(def);
  }
  ctx.targets = keep;
  return { ok: true };
};

// ── Step 4: wire ─────────────────────────────────────────────────────────────
export const stepWire: Step = async (deps, ctx) => {
  if (ctx.targets.length === 0) return { ok: true };
  deps.io.print();
  deps.io.print(`  ${C.bold("5/9  Connecting")}`);
  const separate = ctx.flags.separateAgents && supportsPerClientAgent(ctx.opts.apiKey);
  for (const def of ctx.targets) {
    let opts = ctx.opts;
    let owned = false;
    if (separate) {
      const per = await deps.provisionAgent(def.key, ctx.opts);
      if (per) {
        opts = per;
        owned = true;
      }
    }
    const line = deps.wire(def.key, opts, ctx.pathCtx);
    deps.io.print("    " + line + (owned ? C.dim("  · own identity") : ""));
    ctx.wired.push(def.key);
  }
  return { ok: true };
};

// ── Step 5: verify (stack + pgvector + write) ────────────────────────────────
export const stepVerify: Step = async (deps, ctx) => {
  deps.io.print();
  deps.io.print(`  ${C.bold("6/9  Verifying the connection")}`);
  const probe = await deps.dbProbe(ctx.opts.databaseUrl);
  ctx.dbReachable = probe.reachable;
  if (!probe.reachable) {
    const usingLocaldev = ctx.opts.databaseUrl === LOCALDEV_DATABASE_URL;
    deps.io.print(`    ${C.yellow("!")} Database not reachable yet ${C.dim(probe.error ? `(${probe.error})` : "")}`);
    deps.io.print(
      usingLocaldev
        ? `      ${C.dim("Start it:")} ${C.green("docker compose up -d")} ${C.dim("(from the myco-brain repo, or ./quickstart.sh)")}`
        : `      ${C.dim("Check DATABASE_URL points at a running Postgres.")}`
    );
    return { ok: false };
  }
  const checks = await checkDatabase(probe);
  for (const line of summarize(checks).lines) deps.io.print("    " + colorizeCheck(line));
  ctx.pgvector = checks.find((c) => c.id === "pgvector")?.status === "ok";
  const writeOk = checks.find((c) => c.id === "db_write")?.status === "ok";
  return { ok: !!writeOk };
};

// ── Step 6: history-import offer (never silent) ──────────────────────────────
export const stepHistoryImport: Step = async (deps, ctx) => {
  deps.io.print();
  deps.io.print(`  ${C.bold("7/9  Import your history")} ${C.dim("(optional)")}`);
  if (ctx.flags.noImport) {
    deps.io.print(`    ${C.dim("Skipped (--no-import).")}`);
    return { ok: true };
  }
  const cand = await scanForExport(deps.downloadsDir, deps.scanIo);
  if (!cand) {
    deps.io.print(`    ${C.dim("No ChatGPT/Claude export found in")} ${tilde(deps.downloadsDir, ctx.pathCtx)}${C.dim(".")}`);
    deps.io.print(`    ${C.dim("Export your history later, then:")} ${C.green("mycobrain-ingest --from chatgpt-export <zip>")}`);
    return { ok: true };
  }
  deps.io.print(`    ${C.cyan("Found:")} ${C.bold(describeCandidate(cand))} ${C.dim(`(${cand.filename})`)}`);
  const go = ctx.flags.forceImport || ctx.flags.yes || (await deps.io.confirm(`    Import it into your brain now?`, true));
  if (!go) {
    deps.io.print(`    ${C.dim("Skipped — import any time with")} ${C.green(`mycobrain-ingest --from ${cand.kind} ${cand.filename}`)}`);
    return { ok: true };
  }
  deps.io.print(`    ${C.dim(`Importing ${providerLabel(cand.kind)} history…`)}`);
  const r = await deps.runImport(cand, ctx.opts);
  deps.io.print(r.ok ? `    ${C.green("✓")} ${r.detail}` : `    ${C.yellow("!")} ${r.detail}`);
  if (r.ok) ctx.importedCount = (ctx.importedCount ?? 0) + 1;
  return { ok: true };
};

// ── Step 7: doctor + auto-fix ────────────────────────────────────────────────
export const stepDoctor: Step = async (deps, ctx) => {
  deps.io.print();
  deps.io.print(`  ${C.bold("8/9  Health check")}`);
  // Only attempt model auto-pulls when we have a reachable DB and a real TTY;
  // a non-interactive run just reports.
  const r = deps.runDoctor(ctx.opts, ctx.dbReachable);
  return { ok: r.ok };
};

// ── Step 8: summary + agent instructions ─────────────────────────────────────
export const stepSummary: Step = async (deps, ctx) => {
  deps.io.print();
  deps.io.print(`  ${C.bold("9/9  You're set")}`);
  if (ctx.wired.length > 0) {
    const labels = ctx.wired.map((k) => findClient(k)?.label ?? k).join(", ");
    deps.io.print(`    ${C.green("✓")} Connected: ${C.bold(labels)} ${C.dim("— restart those apps to load Myco.")}`);
  } else {
    deps.io.print(`    ${C.dim("No clients were wired.")} Add one any time: ${C.green("mycobrain-setup --client cursor")}`);
  }
  if (ctx.importedCount) deps.io.print(`    ${C.green("✓")} Imported your assistant history.`);
  if (!ctx.dbReachable) {
    deps.io.print(`    ${C.yellow("!")} Start the database, then re-run ${C.green("mycobrain-doctor")} to confirm.`);
  } else if (!ctx.pgvector) {
    deps.io.print(`    ${C.dim("Semantic search is off (no pgvector) — recall is keyword-only for now.")}`);
  }
  deps.io.print();
  deps.io.print(`    ${C.bold("Paste these agent instructions")} ${C.dim("into CLAUDE.md / .cursorrules / AGENTS.md:")}`);
  deps.io.print(indent(AGENT_INSTRUCTIONS, 4));
  deps.io.print();
  deps.io.print(`    ${C.dim("Then open your agent and ask it something you've worked on — it remembers now.")}`);
  return { ok: true };
};

const STEPS: Array<[string, Step]> = [
  ["prerequisites", stepPrerequisites],
  ["connection", stepConnectionConsent],
  ["detect", stepClientDetection],
  ["consent", stepPerClientConsent],
  ["wire", stepWire],
  ["verify", stepVerify],
  ["import", stepHistoryImport],
  ["doctor", stepDoctor],
  ["summary", stepSummary],
];

/** Run the guided install end-to-end. Stops early (gracefully) on a halt. */
export async function runGuidedInstall(deps: GuidedDeps, ctx: GuidedCtx): Promise<GuidedSummary> {
  for (const [name, step] of STEPS) {
    const r = await step(deps, ctx);
    if (r.halt) {
      deps.io.print();
      deps.io.print(`  ${C.yellow("Setup stopped.")} ${C.dim(`Nothing more was changed.`)}`);
      return {
        completed: false,
        stoppedAt: name,
        wired: ctx.wired,
        dbReachable: ctx.dbReachable,
        importedCount: ctx.importedCount,
      };
    }
  }
  return {
    completed: true,
    wired: ctx.wired,
    dbReachable: ctx.dbReachable,
    importedCount: ctx.importedCount,
  };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────
export function dbPortOf(databaseUrl: string): number {
  try {
    const p = new URL(databaseUrl).port;
    return p ? Number(p) : 5432;
  } catch {
    return 5432;
  }
}

export function describeDatabase(databaseUrl: string): string {
  try {
    const u = new URL(databaseUrl);
    const db = u.pathname.replace(/^\//, "") || "?";
    return `${u.hostname}:${u.port || "5432"}/${db}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

export function maskKey(apiKey: string): string {
  if (!apiKey.startsWith("brain_")) return C.dim("(custom)");
  const parts = apiKey.split("_");
  const ws = parts[1] ? parts[1].slice(0, 8) : "????????";
  return `brain_${ws}…`;
}

function colorizeCheck(line: string): string {
  if (line.startsWith("✓")) return C.green("✓") + line.slice(1);
  if (line.startsWith("!")) return C.yellow("!") + line.slice(1);
  if (line.startsWith("✗")) return C.red("✗") + line.slice(1);
  return line;
}

function tilde(path: string, ctx: PathCtx): string {
  return path.startsWith(ctx.home) ? "~" + path.slice(ctx.home.length) : path;
}
function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s.split("\n").map((l) => (l ? pad + l : l)).join("\n");
}

// ── Real-I/O construction (only reached when run as a binary) ────────────────
function realIo(): Io {
  return {
    print: (line = "") => console.log(line),
    confirm: async (question, def) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) return def;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const hint = def ? "[Y/n]" : "[y/N]";
      const ans = await new Promise<string>((res) => rl.question(`${question} ${hint} `, res));
      rl.close();
      const a = ans.trim().toLowerCase();
      if (a === "") return def;
      return a === "y" || a === "yes";
    },
  };
}

// Live DB probe: reachable? pgvector present? can we actually write? The write
// test uses a TEMP table inside a rolled-back transaction — proves write
// capability without leaving anything behind.
async function realDbProbe(databaseUrl: string): Promise<DbProbeResult> {
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 2500 });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } catch (err) {
    await client.end().catch(() => {});
    return { reachable: false, error: (err as Error).message, hasVectorExtension: async () => false, canWrite: async () => false };
  }
  return {
    reachable: true,
    hasVectorExtension: async () => {
      try {
        const r = await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
        return (r.rowCount ?? 0) > 0;
      } catch {
        return false;
      }
    },
    canWrite: async () => {
      try {
        await client.query("BEGIN");
        await client.query("CREATE TEMP TABLE _myco_write_probe (x int) ON COMMIT DROP");
        await client.query("ROLLBACK");
        return true;
      } catch {
        await client.query("ROLLBACK").catch(() => {});
        return false;
      } finally {
        await client.end().catch(() => {});
      }
    },
  };
}

// Real export scan — newest-first .zip list, entry names + conversations.json
// via `unzip`. Mirrors ingest-cli's helpers (kept private there).
function realScanIo(): ScanIo {
  return {
    listZips: async (dir) => {
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        return [];
      }
      const zips = names.filter((n) => n.toLowerCase().endsWith(".zip")).map((n) => join(dir, n));
      const withTime = await Promise.all(
        zips.map(async (p) => ({ p, t: await fs.stat(p).then((s) => s.mtimeMs).catch(() => 0) }))
      );
      return withTime.sort((a, b) => b.t - a.t).map((x) => x.p);
    },
    entriesOf: (zipPath) =>
      execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    readConversationsJson: (zipPath) =>
      execFileSync("unzip", ["-p", zipPath, "conversations.json"], { maxBuffer: 1024 * 1024 * 1024 }).toString("utf8"),
  };
}

function distBin(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), name);
}

function realRunImport(cand: ExportCandidate, opts: InstallOpts): Promise<{ ok: boolean; detail: string }> {
  const childEnv: Record<string, string> = { ...process.env, DATABASE_URL: opts.databaseUrl, BRAIN_API_KEY: opts.apiKey };
  if (opts.workspaceId) childEnv.BRAIN_WORKSPACE_ID = opts.workspaceId;
  const r = spawnSync(process.execPath, [distBin("ingest-cli.js"), "--from", cand.kind, cand.zipPath], {
    stdio: "inherit",
    env: childEnv,
  });
  if (r.error) return Promise.resolve({ ok: false, detail: `import failed: ${r.error.message}` });
  return Promise.resolve(
    r.status === 0
      ? { ok: true, detail: `Imported your ${providerLabel(cand.kind)} history.` }
      : { ok: false, detail: `import exited with code ${r.status}` }
  );
}

function realRunDoctor(opts: InstallOpts, fix: boolean): { ok: boolean } {
  const childEnv: Record<string, string> = { ...process.env, DATABASE_URL: opts.databaseUrl, BRAIN_API_KEY: opts.apiKey };
  if (opts.workspaceId) childEnv.BRAIN_WORKSPACE_ID = opts.workspaceId;
  const args = [distBin("doctor.js")];
  if (fix && process.stdout.isTTY) args.push("--fix");
  const r = spawnSync(process.execPath, args, { stdio: "inherit", env: childEnv });
  return { ok: !r.error && r.status === 0 };
}

// Mint a per-client agent row + key. Best-effort: any failure (DB unreachable,
// non-brain key, missing workspace) returns null so the installer falls back to
// the shared key and the connection still succeeds.
async function realProvisionAgent(clientKey: string, opts: InstallOpts): Promise<InstallOpts | null> {
  if (!supportsPerClientAgent(opts.apiKey)) return null;
  try {
    const pg = (await import("pg")).default;
    const client = new pg.Client({ connectionString: opts.databaseUrl, connectionTimeoutMillis: 2500 });
    await client.connect();
    try {
      const { apiKey } = await provisionClientAgent(
        client as unknown as import("pg").PoolClient,
        opts.apiKey,
        clientKey
      );
      return { ...opts, apiKey };
    } finally {
      await client.end().catch(() => {});
    }
  } catch {
    return null;
  }
}

export function parseGuidedArgs(argv: string[]): { flags: GuidedFlags; opts: InstallOpts } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const databaseUrl = get("--db-url") || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || LOCALDEV_DATABASE_URL;
  const apiKey = get("--api-key") || process.env.BRAIN_API_KEY || LOCALDEV_API_KEY;
  const workspaceId = get("--workspace-id") || process.env.BRAIN_WORKSPACE_ID;
  return {
    flags: {
      yes: argv.includes("--yes") || argv.includes("-y"),
      all: argv.includes("--all"),
      client: get("--client"),
      forceImport: argv.includes("--import"),
      noImport: argv.includes("--no-import"),
      separateAgents: !argv.includes("--shared-agent"),
    },
    opts: { databaseUrl, apiKey, workspaceId },
  };
}

async function main(): Promise<void> {
  const { flags, opts } = parseGuidedArgs(process.argv.slice(2));
  const pathCtx: PathCtx = {
    platform: osPlatform(),
    home: homedir(),
    appData: process.env.APPDATA,
    cwd: process.cwd(),
    scope: "user",
  };
  const deps: GuidedDeps = {
    io: realIo(),
    probes: realProbes,
    detect: detectInstalled,
    wire: installClient,
    dbProbe: realDbProbe,
    scanIo: realScanIo(),
    downloadsDir: process.env.BRAIN_WATCH_DIR || join(homedir(), "Downloads"),
    runImport: realRunImport,
    runDoctor: realRunDoctor,
    provisionAgent: realProvisionAgent,
  };
  const ctx: GuidedCtx = {
    opts,
    pathCtx,
    flags,
    targets: [],
    wired: [],
    preflightOk: false,
    dbReachable: false,
    pgvector: false,
  };

  console.log(`\n  ${C.bold("🧠 Myco Brain — guided setup")}`);
  await runGuidedInstall(deps, ctx);
}

// Run main() only when invoked as a binary (importing for tests must not run it).
// npm installs the bin as a symlink, so compare REAL paths (see install.ts).
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
      console.error(`\nsetup failed: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
