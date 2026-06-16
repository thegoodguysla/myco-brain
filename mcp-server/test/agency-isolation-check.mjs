#!/usr/bin/env node
/**
 * Agency multi-tenant isolation check (WO-4) — GATED on a database, no LLM.
 *
 * The agency model: one workspace per client + a shared "agency playbook"
 * workspace, all under the agency's tenant. This proves the promise an
 * agency sells its clients: **Client A's agent cannot read Client B's
 * facts.** That guarantee is Postgres row-level security (the
 * `workspace_isolation` policy on every table), and RLS only binds a role
 * that is NOT a superuser and does NOT have BYPASSRLS.
 *
 * So this check does something the other gated tests don't: it connects as a
 * dedicated least-privilege role (mirroring an agency deployment) and proves
 * isolation there — and it demonstrates that the default superuser connection
 * BYPASSES isolation, which is exactly why an agency must use the app role
 * from examples/agency/. See docs: examples/agency/README.md.
 *
 * Run-scoped, cleans up after itself. Skips (exit 0) if DATABASE_URL unset.
 */
if (!process.env.DATABASE_URL) {
  console.log("[skip] agency isolation check — DATABASE_URL is not set.");
  process.exit(0);
}

const { default: pg } = await import("pg");

const TENANT = "00000000-0000-0000-0000-0000000ac000";
const WS_A = "00000000-0000-0000-0000-00000c11e0a1";
const WS_B = "00000000-0000-0000-0000-00000c11e0b2";
const WS_PLAY = "00000000-0000-0000-0000-0000000b00b0";
const APP_ROLE = "brain_app_isocheck";
const APP_PW = "isocheck";

const run = `${Date.now()}`;
const MARK = `Agencyprobe${run}`;
let failed = 0;
const ok = (m) => console.log(`ok    ${m}`);
const fail = (m) => { failed++; console.error(`FAIL  ${m}`); };

const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
await admin.connect();

// Build the least-privilege role's connection string from the admin DSN
// (same host/db, different user) so this works locally and in CI.
const appUrl = (() => {
  const u = new URL(process.env.DATABASE_URL);
  u.username = APP_ROLE;
  u.password = APP_PW;
  return u.toString();
})();

// DROP ROLE fails while the role still holds grants — DROP OWNED BY first
// clears every privilege granted to it (and any objects it owns).
const dropAppRole = async () => {
  const exists = (await admin.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [APP_ROLE])).rowCount;
  if (exists) {
    await admin.query(`DROP OWNED BY ${APP_ROLE}`).catch(() => {});
    await admin.query(`DROP ROLE ${APP_ROLE}`).catch(() => {});
  }
};
const cleanup = async () => {
  for (const ws of [WS_A, WS_B, WS_PLAY]) {
    await admin.query(`DELETE FROM hyobjects WHERE workspace_id = $1`, [ws]).catch(() => {});
    await admin.query(`DELETE FROM agents WHERE workspace_id = $1`, [ws]).catch(() => {});
    await admin.query(`DELETE FROM workspaces WHERE workspace_id = $1`, [ws]).catch(() => {});
  }
  await admin.query(`DELETE FROM tenants WHERE tenant_id = $1`, [TENANT]).catch(() => {});
  await dropAppRole();
};
await cleanup();

// ── Provision the agency (as admin): tenant → workspaces → agents → seed ─────
await admin.query(
  `INSERT INTO tenants (tenant_id, name, slug) VALUES ($1,'Isolation Test Agency',$2)
   ON CONFLICT (tenant_id) DO NOTHING`, [TENANT, `iso-agency-${run}`]);
const mkWs = (ws, label) => admin.query(
  `INSERT INTO workspaces (workspace_id, name, slug, plan, settings, tenant_id, status)
   VALUES ($1,$2,$3,'free','{}'::jsonb,$4,'active') ON CONFLICT (workspace_id) DO NOTHING`,
  [ws, `${label} ${run}`, `${label}-${run}`.toLowerCase(), TENANT]);
await mkWs(WS_A, "client-a");
await mkWs(WS_B, "client-b");
await mkWs(WS_PLAY, "playbook");
// sharing_type 2 = workspace-shared, so the restrictive llm gate is satisfied
// for an 'agent' principal (the realistic agency case).
const seed = (ws, label) => admin.query(
  `INSERT INTO hyobjects (workspace_id, name, type_id, subtype_id, sharing_type_id)
   VALUES ($1,$2,1,1,2)`, [ws, `${MARK}-${label}`]);
await seed(WS_A, "ClientA");
await seed(WS_B, "ClientB");
await seed(WS_PLAY, "Playbook");
ok("provisioned agency tenant + 2 client workspaces + shared playbook (seeded)");

// ── Create the least-privilege app role an agency deployment would use ───────
await dropAppRole();
await admin.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
await admin.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${APP_ROLE}`);
ok(`created least-privilege role ${APP_ROLE} (NOSUPERUSER, NOBYPASSRLS)`);

// Helper: count visible marked rows for a given workspace, under a session
// scoped to `scopeWs` (mirrors what withSession sets).
const visibleUnder = async (client, scopeWs, targetWs) => {
  await client.query("BEGIN");
  await client.query(`SELECT set_config('app.workspace_id',$1,true)`, [scopeWs]);
  await client.query(`SELECT set_config('app.principal_role','agent',true)`, []);
  await client.query(`SELECT set_config('app.tenant_id',$1,true)`, [TENANT]);
  const r = await client.query(
    `SELECT count(*)::int AS n FROM hyobjects WHERE workspace_id=$1 AND name LIKE $2`,
    [targetWs, `${MARK}%`]);
  await client.query("COMMIT");
  return r.rows[0].n;
};

// ── Under the LEAST-PRIVILEGE role: Client A sees A, never B ─────────────────
const app = new pg.Client({ connectionString: appUrl });
await app.connect();
const aSeesOwn = await visibleUnder(app, WS_A, WS_A);
const aSeesB = await visibleUnder(app, WS_A, WS_B);
if (aSeesOwn >= 1) ok("app role, scoped to Client A, sees Client A's own facts");
else fail(`app role could not see Client A's own facts (got ${aSeesOwn})`);
if (aSeesB === 0) ok("app role, scoped to Client A, sees ZERO of Client B's facts (Postgres RLS)");
else fail(`ISOLATION BREACH: app role scoped to A saw ${aSeesB} of Client B's facts`);

const bSeesA = await visibleUnder(app, WS_B, WS_A);
if (bSeesA === 0) ok("app role, scoped to Client B, sees ZERO of Client A's facts");
else fail(`ISOLATION BREACH: app role scoped to B saw ${bSeesA} of Client A's facts`);

// ── The shared playbook is visible when scoped to the playbook workspace ─────
const playVisible = await visibleUnder(app, WS_PLAY, WS_PLAY);
if (playVisible >= 1) ok("shared agency playbook is readable in the playbook workspace");
else fail("playbook doc not visible in playbook workspace");

// ── Demonstrate WHY the role matters: the superuser default BYPASSES it ──────
const adminSeesBWhileScopedToA = await visibleUnder(admin, WS_A, WS_B);
const bypass = (await admin.query(
  `SELECT rolbypassrls OR rolsuper AS b FROM pg_roles WHERE rolname = current_user`)).rows[0].b;
if (bypass && adminSeesBWhileScopedToA >= 1) {
  ok(`default superuser connection BYPASSES isolation (saw ${adminSeesBWhileScopedToA} cross-client rows) — agencies MUST use the app role`);
} else if (!bypass) {
  ok("default connection is already non-bypass — isolation holds for it too");
} else {
  fail("expected the superuser default to bypass RLS, but it did not — investigate");
}

await app.end();
await cleanup();
await admin.end();
console.log(`\n=== ${failed === 0 ? "PASS" : "FAIL"} (agency isolation) ===`);
process.exit(failed === 0 ? 0 : 1);
