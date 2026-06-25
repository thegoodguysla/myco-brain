import { describe, it, expect } from "vitest";
import {
  runGuidedInstall,
  parseGuidedArgs,
  describeDatabase,
  maskKey,
  dbPortOf,
  type GuidedDeps,
  type GuidedCtx,
  type GuidedFlags,
  type Io,
  type DbProbeResult,
} from "./guided-install.js";
import { CLIENTS, findClient, LOCALDEV_API_KEY, LOCALDEV_DATABASE_URL, type InstallOpts, type PathCtx } from "./install.js";
import type { ScanIo } from "./history-import.lib.js";
import type { PreflightProbes } from "./preflight.js";

// ── Test doubles ─────────────────────────────────────────────────────────────
function scriptedIo(answers: boolean[]): Io & { confirms: string[]; lines: string[] } {
  const confirms: string[] = [];
  const lines: string[] = [];
  let i = 0;
  return {
    confirms,
    lines,
    print: (l = "") => lines.push(l),
    confirm: async (q, _def) => {
      confirms.push(q);
      if (i >= answers.length) throw new Error(`unexpected prompt: ${q}`);
      return answers[i++];
    },
  };
}

function healthyProbes(over: Partial<PreflightProbes> = {}): PreflightProbes {
  return {
    hasCommand: () => true,
    portInUse: async () => true, // stack port occupied == healthy for localdev
    nodeVersion: () => "20.0.0",
    isTTY: () => true,
    ...over,
  };
}

function goodDb(): DbProbeResult {
  return { reachable: true, hasVectorExtension: async () => true, canWrite: async () => true };
}

const scanIoWithCandidate = (calls: { listZips: number }): ScanIo => ({
  listZips: async () => {
    calls.listZips++;
    return ["/dl/chatgpt-export.zip"];
  },
  entriesOf: () => ["conversations.json", "user.json"],
  readConversationsJson: () =>
    JSON.stringify([
      {
        id: "c1",
        title: "t",
        create_time: 1_700_000_000,
        current_node: "b",
        mapping: {
          a: { id: "a", parent: null, message: { author: { role: "user" }, content: { parts: ["hi"] } } },
          b: { id: "b", parent: "a", message: { author: { role: "assistant" }, content: { parts: ["yo"] } } },
        },
      },
    ]),
});

interface Spies {
  wired: string[];
  wireKeys: string[]; // apiKey passed to each wire call (to prove per-client keys)
  provisioned: string[];
  imports: number;
  doctorRuns: number;
  scanCalls: { listZips: number };
}

function makeDeps(io: Io, over: Partial<GuidedDeps> = {}): { deps: GuidedDeps; spies: Spies } {
  const spies: Spies = { wired: [], wireKeys: [], provisioned: [], imports: 0, doctorRuns: 0, scanCalls: { listZips: 0 } };
  const deps: GuidedDeps = {
    io,
    probes: healthyProbes(),
    detect: () => [findClient("cursor")!, findClient("claude-desktop")!],
    wire: (key, opts) => {
      spies.wired.push(key);
      spies.wireKeys.push(opts.apiKey);
      return `wired ${key}`;
    },
    dbProbe: async () => goodDb(),
    scanIo: scanIoWithCandidate(spies.scanCalls),
    downloadsDir: "/dl",
    runImport: async () => {
      spies.imports++;
      return { ok: true, detail: "Imported." };
    },
    runDoctor: () => {
      spies.doctorRuns++;
      return { ok: true };
    },
    provisionAgent: async (clientKey, opts) => {
      spies.provisioned.push(clientKey);
      return { ...opts, apiKey: `brain_ws_agent-${clientKey}_secret` };
    },
    ...over,
  };
  return { deps, spies };
}

function makeCtx(flags: Partial<GuidedFlags> = {}, opts?: InstallOpts): GuidedCtx {
  const pathCtx: PathCtx = { platform: "darwin", home: "/home/u", cwd: "/work", scope: "user" };
  return {
    opts: opts ?? { databaseUrl: LOCALDEV_DATABASE_URL, apiKey: LOCALDEV_API_KEY },
    pathCtx,
    flags: { yes: false, all: false, forceImport: false, noImport: false, separateAgents: false, ...flags },
    targets: [],
    wired: [],
    preflightOk: false,
    dbReachable: false,
    pgvector: false,
  };
}

// ── Orchestration ────────────────────────────────────────────────────────────
describe("guided-install: happy path (interactive)", () => {
  it("wires detected clients, verifies, imports, and completes", async () => {
    // connection=yes, cursor=yes, claude-desktop=yes, import=yes
    const io = scriptedIo([true, true, true, true]);
    const { deps, spies } = makeDeps(io);
    const ctx = makeCtx();
    const sum = await runGuidedInstall(deps, ctx);

    expect(sum.completed).toBe(true);
    expect(spies.wired).toEqual(["cursor", "claude-desktop"]);
    expect(spies.imports).toBe(1);
    expect(spies.doctorRuns).toBe(1);
    expect(sum.importedCount).toBe(1);
    expect(sum.dbReachable).toBe(true);
  });
});

describe("guided-install: --yes is non-interactive consent", () => {
  it("never prompts, still wires all detected and imports", async () => {
    const io = scriptedIo([]); // any confirm() throws
    const { deps, spies } = makeDeps(io);
    const sum = await runGuidedInstall(deps, makeCtx({ yes: true }));
    expect(io.confirms.length).toBe(0);
    expect(spies.wired).toEqual(["cursor", "claude-desktop"]);
    expect(spies.imports).toBe(1);
    expect(sum.completed).toBe(true);
  });
});

describe("guided-install: explicit client selection", () => {
  it("--client cursor targets exactly that one (no per-client prompt)", async () => {
    const io = scriptedIo([]);
    const { deps, spies } = makeDeps(io);
    const sum = await runGuidedInstall(deps, makeCtx({ yes: true, client: "cursor" }));
    expect(spies.wired).toEqual(["cursor"]);
    expect(sum.completed).toBe(true);
  });

  it("--all targets every auto-write client", async () => {
    const io = scriptedIo([]);
    const { deps, spies } = makeDeps(io);
    await runGuidedInstall(deps, makeCtx({ yes: true, all: true }));
    const autoWrite = CLIENTS.filter((c) => c.kind !== "print").map((c) => c.key);
    expect(spies.wired).toEqual(autoWrite);
  });

  it("an unknown --client halts before wiring", async () => {
    const io = scriptedIo([]);
    const { deps, spies } = makeDeps(io);
    const sum = await runGuidedInstall(deps, makeCtx({ yes: true, client: "nope" }));
    expect(sum.completed).toBe(false);
    expect(sum.stoppedAt).toBe("detect");
    expect(spies.wired).toEqual([]);
  });
});

describe("guided-install: prerequisite gate", () => {
  it("a hard fail + declining to continue halts, wiring nothing", async () => {
    const io = scriptedIo([false]); // "continue anyway?" -> no
    const { deps, spies } = makeDeps(io, { probes: healthyProbes({ hasCommand: (c) => c !== "npm" }) });
    const sum = await runGuidedInstall(deps, makeCtx());
    expect(sum.completed).toBe(false);
    expect(sum.stoppedAt).toBe("prerequisites");
    expect(spies.wired).toEqual([]);
  });

  it("--yes pushes past a prerequisite fail", async () => {
    const io = scriptedIo([]);
    const { deps, spies } = makeDeps(io, { probes: healthyProbes({ hasCommand: (c) => c !== "npm" }) });
    const sum = await runGuidedInstall(deps, makeCtx({ yes: true }));
    expect(sum.completed).toBe(true);
    expect(spies.wired.length).toBeGreaterThan(0);
  });
});

describe("guided-install: per-client consent", () => {
  it("only wires the clients the user says yes to", async () => {
    // connection=yes, cursor=NO, claude-desktop=yes, import=yes
    const io = scriptedIo([true, false, true, true]);
    const { deps, spies } = makeDeps(io);
    await runGuidedInstall(deps, makeCtx());
    expect(spies.wired).toEqual(["claude-desktop"]);
  });
});

describe("guided-install: connection consent", () => {
  it("declining the connection halts immediately", async () => {
    const io = scriptedIo([false]); // connection -> no
    const { deps, spies } = makeDeps(io);
    const sum = await runGuidedInstall(deps, makeCtx());
    expect(sum.stoppedAt).toBe("connection");
    expect(spies.wired).toEqual([]);
  });
});

describe("guided-install: verify is non-blocking", () => {
  it("an unreachable DB does not halt; flow finishes and flags it", async () => {
    const io = scriptedIo([]);
    const { deps, spies } = makeDeps(io, {
      dbProbe: async () => ({ reachable: false, error: "ECONNREFUSED", hasVectorExtension: async () => false, canWrite: async () => false }),
    });
    const sum = await runGuidedInstall(deps, makeCtx({ yes: true }));
    expect(sum.completed).toBe(true);
    expect(sum.dbReachable).toBe(false);
    expect(spies.wired.length).toBeGreaterThan(0); // wiring happened before verify
  });
});

describe("guided-install: history import", () => {
  it("--no-import skips the scan entirely", async () => {
    const io = scriptedIo([]);
    const { deps, spies } = makeDeps(io);
    await runGuidedInstall(deps, makeCtx({ yes: true, noImport: true }));
    expect(spies.scanCalls.listZips).toBe(0);
    expect(spies.imports).toBe(0);
  });

  it("no export found -> no import, flow still completes", async () => {
    const io = scriptedIo([]);
    const { deps, spies } = makeDeps(io, {
      scanIo: { listZips: async () => [], entriesOf: () => [], readConversationsJson: () => "" },
    });
    const sum = await runGuidedInstall(deps, makeCtx({ yes: true }));
    expect(spies.imports).toBe(0);
    expect(sum.importedCount).toBeUndefined();
    expect(sum.completed).toBe(true);
  });

  it("declining the import offer leaves history untouched", async () => {
    // connection=yes, cursor=yes, claude-desktop=yes, import=NO
    const io = scriptedIo([true, true, true, false]);
    const { deps, spies } = makeDeps(io);
    await runGuidedInstall(deps, makeCtx());
    expect(spies.imports).toBe(0);
  });
});

describe("guided-install: per-client agent identity", () => {
  it("separate agents: mints one per client and wires its per-client key", async () => {
    // connection=yes, separate-identity=yes, cursor=yes, claude-desktop=yes, import=yes
    const io = scriptedIo([true, true, true, true, true]);
    const { deps, spies } = makeDeps(io);
    await runGuidedInstall(deps, makeCtx({ separateAgents: true }));
    expect(spies.provisioned).toEqual(["cursor", "claude-desktop"]);
    expect(spies.wireKeys).toEqual(["brain_ws_agent-cursor_secret", "brain_ws_agent-claude-desktop_secret"]);
  });

  it("--yes keeps separate-agents on without prompting", async () => {
    const io = scriptedIo([]);
    const { deps, spies } = makeDeps(io);
    await runGuidedInstall(deps, makeCtx({ yes: true, separateAgents: true }));
    expect(io.confirms.length).toBe(0);
    expect(spies.provisioned).toEqual(["cursor", "claude-desktop"]);
  });

  it("declining the identity prompt falls back to the shared key", async () => {
    // connection=yes, separate-identity=NO, cursor=yes, claude-desktop=yes, import=yes
    const io = scriptedIo([true, false, true, true, true]);
    const { deps, spies } = makeDeps(io);
    await runGuidedInstall(deps, makeCtx({ separateAgents: true }));
    expect(spies.provisioned).toEqual([]);
    expect(spies.wireKeys.every((k) => k === LOCALDEV_API_KEY)).toBe(true);
  });

  it("a mint failure (null) falls back to the shared key, flow still completes", async () => {
    const io = scriptedIo([]);
    const { deps, spies } = makeDeps(io, { provisionAgent: async () => null });
    const sum = await runGuidedInstall(deps, makeCtx({ yes: true, separateAgents: true }));
    expect(sum.completed).toBe(true);
    expect(spies.wireKeys.every((k) => k === LOCALDEV_API_KEY)).toBe(true);
  });

  it("--shared-agent (separateAgents false) never mints", async () => {
    const io = scriptedIo([]);
    const { deps, spies } = makeDeps(io);
    await runGuidedInstall(deps, makeCtx({ yes: true, separateAgents: false }));
    expect(spies.provisioned).toEqual([]);
  });
});

// ── Pure helpers ─────────────────────────────────────────────────────────────
describe("guided-install: helpers", () => {
  it("describeDatabase shows host:port/db, hiding credentials", () => {
    expect(describeDatabase(LOCALDEV_DATABASE_URL)).toBe("localhost:5432/brain");
    expect(describeDatabase("not a url")).toMatch(/unparseable/);
  });

  it("maskKey shows only the workspace prefix", () => {
    expect(maskKey(LOCALDEV_API_KEY)).toMatch(/^brain_00000000…$/);
    expect(maskKey("opaque")).toMatch(/custom/);
  });

  it("dbPortOf parses the port, defaulting to 5432", () => {
    expect(dbPortOf("postgresql://h:55543/brain")).toBe(55543);
    expect(dbPortOf(LOCALDEV_DATABASE_URL)).toBe(5432);
    expect(dbPortOf("garbage")).toBe(5432);
  });

  it("parseGuidedArgs reads flags + connection overrides", () => {
    const { flags, opts } = parseGuidedArgs(["--all", "--no-import", "--db-url", "postgresql://x/y", "--api-key", "k"]);
    expect(flags.all).toBe(true);
    expect(flags.noImport).toBe(true);
    expect(flags.separateAgents).toBe(true); // default on
    expect(opts.databaseUrl).toBe("postgresql://x/y");
    expect(opts.apiKey).toBe("k");
  });

  it("--shared-agent turns off per-client identities", () => {
    expect(parseGuidedArgs(["--shared-agent"]).flags.separateAgents).toBe(false);
  });
});
