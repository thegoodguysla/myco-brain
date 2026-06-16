#!/usr/bin/env node
/**
 * Provision an agency: one isolated workspace per client + one shared
 * "agency playbook" workspace, all under the agency's tenant. Prints the
 * per-client MCP client config you drop into Claude / Cursor / etc.
 *
 * Isolation between clients is Postgres row-level security — which only binds
 * a non-superuser, NOBYPASSRLS role. So the emitted config connects the MCP
 * server as `brain_app` (create it first with sql/01_least_privilege_role.sql),
 * NOT as the superuser. See README.md.
 *
 * Usage:
 *   ADMIN_DATABASE_URL=postgresql://brain:brain@localhost:5432/brain \
 *   APP_DATABASE_URL=postgresql://brain_app:<pw>@localhost:5432/brain \
 *     node provision.mjs ./clients.json
 *
 * Idempotent: re-running reuses existing workspaces/agents by slug.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";

const cfgPath = process.argv[2] || "./clients.json";
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const adminUrl = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL;
const appUrl = process.env.APP_DATABASE_URL;
if (!adminUrl) throw new Error("Set ADMIN_DATABASE_URL (the superuser DSN, for provisioning).");
if (!appUrl) throw new Error("Set APP_DATABASE_URL (the brain_app DSN the server will connect as).");

const agencySlug = (cfg.agency || "agency").toLowerCase().replace(/[^a-z0-9-]/g, "-");
const clients = cfg.clients || [];
if (!clients.length) throw new Error("clients.json needs a non-empty `clients` array.");

const db = new pg.Client({ connectionString: adminUrl });
await db.connect();

// Find-or-create by slug, returning the id.
const findOrCreateWorkspace = async (slug, name, tenantId) => {
  const found = await db.query(`SELECT workspace_id FROM workspaces WHERE slug=$1`, [slug]);
  if (found.rowCount) return found.rows[0].workspace_id;
  const id = randomUUID();
  await db.query(
    `INSERT INTO workspaces (workspace_id, name, slug, plan, settings, tenant_id, status)
     VALUES ($1,$2,$3,'pro','{}'::jsonb,$4,'active')`,
    [id, name, slug, tenantId]);
  return id;
};
const ensureAgent = async (wsId, label) => {
  const agentId = randomUUID();
  await db.query(
    `INSERT INTO agents (agent_id, workspace_id, platform, display_name)
     VALUES ($1,$2,'other',$3) ON CONFLICT (agent_id) DO NOTHING`,
    [agentId, wsId, label]);
  return agentId;
};
const keyFor = (wsId, agentId) => `brain_${wsId}_${agentId}_${randomUUID().replace(/-/g, "")}`;

// Tenant = the agency.
let tenantId;
const t = await db.query(`SELECT tenant_id FROM tenants WHERE slug=$1`, [agencySlug]);
if (t.rowCount) tenantId = t.rows[0].tenant_id;
else {
  tenantId = randomUUID();
  await db.query(`INSERT INTO tenants (tenant_id, name, slug) VALUES ($1,$2,$3)`,
    [tenantId, cfg.agency || "Agency", agencySlug]);
}

// Shared playbook workspace (read-only knowledge every client agent can see).
const playbookWs = await findOrCreateWorkspace(`${agencySlug}-playbook`, `${cfg.agency} Playbook`, tenantId);
const playbookAgent = await ensureAgent(playbookWs, "playbook-reader");
const playbookKey = keyFor(playbookWs, playbookAgent);

// Build the DATABASE_URL the server connects as (brain_app — RLS binds it).
const out = { agency: cfg.agency, tenantId, playbookWorkspace: playbookWs, clients: [] };

for (const name of clients) {
  const slug = `${agencySlug}-${String(name).toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
  const wsId = await findOrCreateWorkspace(slug, `${name}`, tenantId);
  const agentId = await ensureAgent(wsId, `${name}-agent`);
  const key = keyFor(wsId, agentId);
  out.clients.push({
    name, workspace: wsId,
    // Two MCP servers per client: their own workspace (read/write) + the
    // shared playbook (read-only). Both connect as brain_app so RLS isolates.
    mcp: {
      mcpServers: {
        brain: {
          command: "npx", args: ["-y", "@mycobrain/mcp-server"],
          env: { DATABASE_URL: appUrl, BRAIN_API_KEY: key },
        },
        "agency-playbook": {
          command: "npx", args: ["-y", "@mycobrain/mcp-server"],
          env: { DATABASE_URL: appUrl, BRAIN_API_KEY: playbookKey },
        },
      },
    },
  });
}

await db.end();

console.log(`\nProvisioned agency "${cfg.agency}" — tenant ${tenantId}`);
console.log(`  ${clients.length} isolated client workspace(s) + 1 shared playbook (${playbookWs})\n`);
console.log("Per-client MCP config (drop into each client's Claude/Cursor/etc.):\n");
for (const c of out.clients) {
  console.log(`# ── ${c.name} (workspace ${c.workspace}) ──`);
  console.log(JSON.stringify(c.mcp, null, 2));
  console.log("");
}
console.log("Isolation is enforced by Postgres RLS via the brain_app role. Prove it:");
console.log("  npm run test:agency\n");
