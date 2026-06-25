/**
 * Pre-flight checks — the "this is needed / here's how to fix it" layer that makes
 * the install survivable for a non-technical user on a fresh machine. Turns the
 * cryptic failure (no Docker / no prereq -> crash) into a clear, consent-driven
 * checklist with remediation. Grounded in the adversarial install review (R1-R10).
 *
 * Probes are injected so the whole module is unit-testable without a real machine.
 */
import { spawnSync } from "node:child_process";
import net from "node:net";

export type CheckStatus = "ok" | "warn" | "fail";

export interface PreflightCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Concrete remediation, shown when status is warn/fail. */
  fix?: string;
}

export interface PreflightProbes {
  hasCommand(cmd: string): boolean;
  portInUse(port: number): Promise<boolean>;
  nodeVersion(): string;
  isTTY(): boolean;
}

export const realProbes: PreflightProbes = {
  hasCommand(cmd) {
    const finder = process.platform === "win32" ? "where" : "which";
    return spawnSync(finder, [cmd], { stdio: "ignore" }).status === 0;
  },
  portInUse(port) {
    return new Promise((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
      sock.setTimeout(1000, () => {
        sock.destroy();
        resolve(false);
      });
    });
  },
  nodeVersion() {
    return process.versions.node;
  },
  isTTY() {
    return !!process.stdout.isTTY;
  },
};

export interface PreflightOptions {
  /** Port we expect the DB on (default 5432, the quickstart stack). */
  dbPort?: number;
  /** True when the DB SHOULD already be listening here (so "occupied" is good,
   *  "free" is the problem). False when we're about to use the port (so
   *  "occupied" is a conflict). */
  expectStackPort?: boolean;
}

/** Machine-level checks (no DB connection needed). */
export async function checkPrerequisites(
  probes: PreflightProbes = realProbes,
  opts: PreflightOptions = {}
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const port = opts.dbPort ?? 5432;

  const nodeV = probes.nodeVersion();
  const major = Number(nodeV.split(".")[0]);
  checks.push({
    id: "node",
    label: "Node.js",
    status: major >= 18 ? "ok" : "warn",
    detail: `v${nodeV}`,
    fix: major >= 18 ? undefined : "Install Node.js 18+ from nodejs.org.",
  });

  checks.push(
    probes.hasCommand("npm")
      ? { id: "npm", label: "npm", status: "ok", detail: "found" }
      : {
          id: "npm",
          label: "npm",
          status: "fail",
          detail: "not on PATH",
          fix: "Install Node.js (bundles npm) from nodejs.org, then re-run.",
        }
  );

  checks.push(
    probes.hasCommand("git")
      ? { id: "git", label: "git", status: "ok", detail: "found" }
      : {
          id: "git",
          label: "git",
          status: "warn",
          detail: "not on PATH",
          fix: "Install git so Myco can auto-detect & index your repo (optional).",
        }
  );

  const hasDocker = probes.hasCommand("docker");
  checks.push({
    id: "docker",
    label: "Docker",
    status: hasDocker ? "ok" : "warn",
    detail: hasDocker ? "found" : "not found",
    fix: hasDocker
      ? undefined
      : "No Docker — point Myco at an existing Postgres with --db-url, or install Docker Desktop for the one-command stack.",
  });

  const occupied = await probes.portInUse(port);
  if (opts.expectStackPort) {
    checks.push(
      occupied
        ? { id: "db_port", label: `DB port ${port}`, status: "ok", detail: "stack reachable" }
        : {
            id: "db_port",
            label: `DB port ${port}`,
            status: "warn",
            detail: "nothing listening",
            fix: "Start the stack (docker compose up -d) or pass --db-url.",
          }
    );
  } else {
    checks.push(
      occupied
        ? {
            id: "db_port",
            label: `DB port ${port}`,
            status: "warn",
            detail: "already in use",
            fix: `Another Postgres may be on ${port}. Use --postgres-port or --db-url to avoid a conflict.`,
          }
        : { id: "db_port", label: `DB port ${port}`, status: "ok", detail: "free" }
    );
  }

  if (!probes.isTTY()) {
    checks.push({
      id: "tty",
      label: "Interactive terminal",
      status: "warn",
      detail: "non-interactive (piped/CI)",
      fix: "Run in a terminal, or pass --yes to accept safe defaults.",
    });
  }

  return checks;
}

/** DB-level checks — need a live connection (probe is injected). */
export interface DbProbe {
  hasVectorExtension(): Promise<boolean>;
  canWrite(): Promise<boolean>;
}

export async function checkDatabase(probe: DbProbe): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const vec = await probe.hasVectorExtension();
  checks.push(
    vec
      ? { id: "pgvector", label: "Semantic search (pgvector)", status: "ok", detail: "enabled" }
      : {
          id: "pgvector",
          label: "Semantic search (pgvector)",
          status: "warn",
          detail: "pgvector not installed — recall is keyword-only",
          fix: "Install pgvector, then backfill embeddings (mycobrain-doctor explains how).",
        }
  );
  const writable = await probe.canWrite();
  checks.push(
    writable
      ? { id: "db_write", label: "Database writes", status: "ok", detail: "writable" }
      : {
          id: "db_write",
          label: "Database writes",
          status: "fail",
          detail: "write test failed",
          fix: "Check DB permissions, or whether antivirus/firewall is blocking writes.",
        }
  );
  return checks;
}

/** Roll up checks: any "fail" blocks; "warn"s surface but don't block. */
export function summarize(checks: PreflightCheck[]): {
  ok: boolean;
  fails: number;
  warns: number;
  lines: string[];
} {
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const sym = (s: CheckStatus) => (s === "ok" ? "✓" : s === "warn" ? "!" : "✗");
  const lines = checks.map(
    (c) => `${sym(c.status)} ${c.label}: ${c.detail}${c.fix ? `  -> ${c.fix}` : ""}`
  );
  return { ok: fails === 0, fails, warns, lines };
}
