#!/usr/bin/env node
/**
 * `npx @mycobrain/install` — the one-command front door.
 *
 * This is a thin, zero-dependency launcher. The real installer lives in
 * @mycobrain/mcp-server (bin: mycobrain-install); keeping this shim separate is
 * what lets the headline command be `npx @mycobrain/install` while always running
 * the latest installer. It forwards every argument through unchanged, e.g.
 *   npx @mycobrain/install --client cursor
 *   npx @mycobrain/install --all --no-onboard
 */
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const r = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["-y", "-p", "@mycobrain/mcp-server@latest", "mycobrain-install", ...args],
  { stdio: "inherit" }
);
if (r.error) {
  console.error("Could not launch the Myco installer via npx. Is Node/npm on your PATH?");
  console.error(String(r.error.message || r.error));
  process.exit(1);
}
process.exit(r.status ?? 1);
