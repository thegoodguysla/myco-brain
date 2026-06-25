import { describe, it, expect } from "vitest";
import {
  checkPrerequisites,
  checkDatabase,
  summarize,
  type PreflightProbes,
} from "./preflight.js";

function probes(over: Partial<PreflightProbes> = {}): PreflightProbes {
  return {
    hasCommand: () => true,
    portInUse: async () => false,
    nodeVersion: () => "20.0.0",
    isTTY: () => true,
    ...over,
  };
}

describe("preflight: prerequisites", () => {
  it("all-green on a healthy machine (about-to-use port should be free)", async () => {
    const checks = await checkPrerequisites(probes(), { dbPort: 5432 });
    const s = summarize(checks);
    expect(s.ok).toBe(true);
    expect(s.fails).toBe(0);
    expect(s.warns).toBe(0);
  });

  it("missing npm is a hard fail with a fix", async () => {
    const checks = await checkPrerequisites(
      probes({ hasCommand: (c) => c !== "npm" })
    );
    const npm = checks.find((c) => c.id === "npm")!;
    expect(npm.status).toBe("fail");
    expect(npm.fix).toMatch(/nodejs\.org/);
    expect(summarize(checks).ok).toBe(false);
  });

  it("missing git / docker are warnings, not blockers", async () => {
    const checks = await checkPrerequisites(
      probes({ hasCommand: (c) => c !== "git" && c !== "docker" })
    );
    expect(checks.find((c) => c.id === "git")!.status).toBe("warn");
    expect(checks.find((c) => c.id === "docker")!.status).toBe("warn");
    expect(summarize(checks).ok).toBe(true); // warnings don't block
  });

  it("port conflict warns when we're about to use the port", async () => {
    const checks = await checkPrerequisites(
      probes({ portInUse: async () => true }),
      { dbPort: 5432, expectStackPort: false }
    );
    const p = checks.find((c) => c.id === "db_port")!;
    expect(p.status).toBe("warn");
    expect(p.fix).toMatch(/--db-url|--postgres-port/);
  });

  it("when the stack is expected, a listening port is GOOD and a free one warns", async () => {
    const reachable = await checkPrerequisites(
      probes({ portInUse: async () => true }),
      { expectStackPort: true }
    );
    expect(reachable.find((c) => c.id === "db_port")!.status).toBe("ok");
    const down = await checkPrerequisites(probes({ portInUse: async () => false }), {
      expectStackPort: true,
    });
    expect(down.find((c) => c.id === "db_port")!.status).toBe("warn");
  });

  it("old Node warns; non-TTY warns", async () => {
    const checks = await checkPrerequisites(
      probes({ nodeVersion: () => "16.20.0", isTTY: () => false })
    );
    expect(checks.find((c) => c.id === "node")!.status).toBe("warn");
    expect(checks.find((c) => c.id === "tty")!.status).toBe("warn");
  });
});

describe("preflight: database", () => {
  it("pgvector missing warns (keyword-only); write failure is a hard fail", async () => {
    const checks = await checkDatabase({
      hasVectorExtension: async () => false,
      canWrite: async () => false,
    });
    expect(checks.find((c) => c.id === "pgvector")!.status).toBe("warn");
    const w = checks.find((c) => c.id === "db_write")!;
    expect(w.status).toBe("fail");
    expect(w.fix).toMatch(/antivirus|firewall|permission/i);
    expect(summarize(checks).ok).toBe(false);
  });

  it("healthy DB is all-ok", async () => {
    const checks = await checkDatabase({
      hasVectorExtension: async () => true,
      canWrite: async () => true,
    });
    expect(summarize(checks).ok).toBe(true);
    expect(summarize(checks).warns).toBe(0);
  });
});
