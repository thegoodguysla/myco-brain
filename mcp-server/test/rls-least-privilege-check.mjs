#!/usr/bin/env node
/**
 * RLS empty-string-GUC regression check — GATED on a database, no LLM.
 *
 * Reproduces the exact failure that blocked running the server under a
 * least-privilege (NOBYPASSRLS) role — the role a multi-tenant / agency
 * deployment MUST use for isolation to actually bind:
 *
 *   withSession() sets the RLS context with transaction-local
 *   set_config('app.workspace_id'|'app.tenant_id', <uuid>, true). When those
 *   local settings revert at transaction end, the custom GUCs are left
 *   "defined but empty": current_setting('app.tenant_id', true) returns ''
 *   (NOT NULL). On a pooled / reused connection the next statement then
 *   evaluated ''::uuid inside an isolation policy → ERROR "invalid input
 *   syntax for type uuid: ''". The default `brain` SUPERUSER never hit this
 *   because it BYPASSES RLS; a NOBYPASSRLS app role hit it on the first query.
 *
 *   Migration 050 wraps every policy GUC read in NULLIF(current_setting(..),'')
 *   so '' is treated exactly like NULL (no filter). Same semantics for NULL and
 *   a valid uuid; only the '' crash is removed.
 *
 * Isolation model note: each isolated table carries a PERMISSIVE
 * workspace_isolation policy AND a RESTRICTIVE tenant_isolation policy. Postgres
 * OR's permissive policies and AND's restrictive ones, so the effective rule is
 * "workspace_id matches AND the workspace's tenant matches" — the WORKSPACE is
 * the binding boundary, with the tenant an added AND-constraint. withSession
 * sets both app.workspace_id and app.tenant_id. Two workspaces in the SAME
 * tenant are therefore isolated from each other. (Migration 050 must recreate
 * tenant_isolation AS RESTRICTIVE; recreating it permissive silently turns the
 * AND into an OR and breaks same-tenant workspace isolation — Test 3 guards it.)
 *
 * Asserts, as a freshly-created NOBYPASSRLS role:
 *   1. After both GUCs revert to '', a query hitting the isolation policies does
 *      NOT throw (the empty-GUC bug; it throws on the pre-050 schema).
 *   2. Cross-tenant: scoped to tenant 1 / workspace A, tenant 2's row is NOT
 *      visible, and vice-versa.
 *   3. Same-tenant: scoped to workspace A, a DIFFERENT workspace C in the SAME
 *      tenant is NOT visible — proves the workspace is the binding boundary and
 *      tenant_isolation kept its AS RESTRICTIVE.
 *
 * Self-contained: creates + drops its own login role and seed rows; safe to
 * rerun. Skips (exit 0) when DATABASE_URL is unset.
 */
if (!process.env.DATABASE_URL) {
  console.log("[skip] rls least-privilege check — DATABASE_URL is not set.");
  process.exit(0);
}

const { default: pg } = await import("pg");

const ROLE = "rls_lpcheck";
const ROLE_PW = "lpcheckpw";
const TENANT_1 = "00000000-0000-0000-0000-0000000c1ee1";
const TENANT_2 = "00000000-0000-0000-0000-0000000c2ee2";
const WS_A = "00000000-0000-0000-0000-0000000a1000"; // under tenant 1
const WS_B = "00000000-0000-0000-0000-0000000b2000"; // under tenant 2
const WS_C = "00000000-0000-0000-0000-0000000c3000"; // under tenant 1 (same tenant as A)
const AG_A = "00000000-0000-0000-0000-0000000a1aaa";
const AG_B = "00000000-0000-0000-0000-0000000b2bbb";
const AG_C = "00000000-0000-0000-0000-0000000c3ccc";

let failed = 0;
const ok = (m) => console.log(`ok    ${m}`);
const fail = (m) => {
  failed++;
  console.error(`FAIL  ${m}`);
};

// Admin (superuser) connection — sets up the role + seed, then tears down.
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
await admin.connect();

async function dropRole() {
  // Guarded so a missing role is a no-op; DROP OWNED clears any grants held.
  await admin.query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
      EXECUTE 'DROP OWNED BY ${ROLE}';
      EXECUTE 'DROP ROLE ${ROLE}';
    END IF;
  END $$;`);
}

// Build the least-privilege role's connection string from DATABASE_URL,
// swapping only the credentials.
function lpConnString() {
  const u = new URL(process.env.DATABASE_URL);
  u.username = ROLE;
  u.password = ROLE_PW;
  return u.toString();
}

let lp;
try {
  // ---- setup -------------------------------------------------------------
  await dropRole();
  await admin.query(
    `CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE_PW}' NOSUPERUSER NOBYPASSRLS`
  );
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  await admin.query(`GRANT SELECT ON agents TO ${ROLE}`);

  // Seed the FK chain (tenant → workspace → agent), one per tenant; superuser
  // bypasses RLS so the seed is unfiltered.
  for (const [ten, slug] of [
    [TENANT_1, "rls-lpcheck-t1"],
    [TENANT_2, "rls-lpcheck-t2"],
  ]) {
    await admin.query(
      `INSERT INTO tenants (tenant_id, name, slug)
       VALUES ($1, $2, $2) ON CONFLICT (tenant_id) DO NOTHING`,
      [ten, slug]
    );
  }
  for (const [ws, ten, slug] of [
    [WS_A, TENANT_1, "rls-lpcheck-wsa"],
    [WS_B, TENANT_2, "rls-lpcheck-wsb"],
    [WS_C, TENANT_1, "rls-lpcheck-wsc"], // same tenant as A, different workspace
  ]) {
    await admin.query(
      `INSERT INTO workspaces (workspace_id, name, slug, tenant_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id) DO NOTHING`,
      [ws, `rls-lpcheck ${slug}`, slug, ten]
    );
  }
  for (const [ag, ws] of [
    [AG_A, WS_A],
    [AG_B, WS_B],
    [AG_C, WS_C],
  ]) {
    await admin.query(
      `INSERT INTO agents (agent_id, workspace_id, platform)
       VALUES ($1, $2, 'other')
       ON CONFLICT (agent_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id`,
      [ag, ws]
    );
  }

  // ---- run as the least-privilege role -----------------------------------
  lp = new pg.Client({ connectionString: lpConnString() });
  await lp.connect();

  // Sanity: confirm we are actually NOBYPASSRLS (else the test proves nothing).
  const who = await lp.query(
    `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`
  );
  if (who.rows[0]?.rolbypassrls || who.rows[0]?.rolsuper) {
    fail(`${ROLE} unexpectedly bypasses RLS — test would be meaningless`);
  } else {
    ok(`running as ${ROLE} (NOSUPERUSER, NOBYPASSRLS)`);
  }

  // -- Test 1: the empty-GUC crash repro -----------------------------------
  // Mimic withSession: set BOTH context GUCs transaction-locally, then revert.
  await lp.query("BEGIN");
  await lp.query(`SELECT set_config('app.workspace_id', $1, true)`, [WS_A]);
  await lp.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_1]);
  await lp.query("COMMIT"); // local settings revert → GUCs now '' on this conn

  const cur = await lp.query(
    `SELECT current_setting('app.workspace_id', true) AS ws,
            current_setting('app.tenant_id', true)    AS ten`
  );
  console.log(
    `info  GUCs after revert: workspace=${JSON.stringify(cur.rows[0].ws)} tenant=${JSON.stringify(cur.rows[0].ten)} (the '' quirk)`
  );

  // The next query on this SAME (reused) connection is what crashed pre-050.
  try {
    await lp.query("SELECT count(*) FROM agents");
    ok("query after GUCs revert to '' does not crash (NULLIF fix holds)");
  } catch (e) {
    fail(`empty-GUC still crashes: ${e.message}`);
  }

  // -- Test 2: cross-tenant isolation still binds under the LP role ---------
  for (const [ten, ws, mine, theirs] of [
    [TENANT_1, WS_A, AG_A, AG_B],
    [TENANT_2, WS_B, AG_B, AG_A],
  ]) {
    await lp.query("BEGIN");
    await lp.query(`SELECT set_config('app.workspace_id', $1, true)`, [ws]);
    await lp.query(`SELECT set_config('app.tenant_id', $1, true)`, [ten]);
    const seen = await lp.query(
      `SELECT agent_id FROM agents WHERE agent_id = ANY($1::text[])`,
      [[mine, theirs]]
    );
    await lp.query("COMMIT");
    const ids = seen.rows.map((r) => r.agent_id);
    if (ids.includes(mine) && !ids.includes(theirs)) {
      ok(`tenant ${ten.slice(0, 13)}… sees only its own row (isolation binds)`);
    } else {
      fail(
        `isolation breach for tenant ${ten}: saw ${JSON.stringify(ids)} (expected only ${mine})`
      );
    }
  }

  // -- Test 3: SAME-tenant cross-workspace isolation (workspace is the binding
  // boundary). WS_A and WS_C share TENANT_1. A session scoped to WS_A must NOT
  // see WS_C's agent. This is what regresses if tenant_isolation is recreated
  // PERMISSIVE instead of AS RESTRICTIVE (it would OR in the whole tenant).
  await lp.query("BEGIN");
  await lp.query(`SELECT set_config('app.workspace_id', $1, true)`, [WS_A]);
  await lp.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_1]);
  const sameTenant = await lp.query(
    `SELECT agent_id FROM agents WHERE agent_id = ANY($1::text[])`,
    [[AG_A, AG_C]]
  );
  await lp.query("COMMIT");
  const stIds = sameTenant.rows.map((r) => r.agent_id);
  if (stIds.includes(AG_A) && !stIds.includes(AG_C)) {
    ok("same-tenant: workspace A cannot see workspace C's row (workspace boundary binds)");
  } else {
    fail(
      `same-tenant workspace leak: saw ${JSON.stringify(stIds)} (expected only ${AG_A}) — ` +
        `tenant_isolation likely lost its AS RESTRICTIVE`
    );
  }
} catch (e) {
  fail(`unexpected: ${e.stack || e.message}`);
} finally {
  // ---- teardown ----------------------------------------------------------
  try {
    if (lp) await lp.end();
  } catch {
    /* ignore */
  }
  try {
    await admin.query(`DELETE FROM agents WHERE agent_id = ANY($1::text[])`, [
      [AG_A, AG_B, AG_C],
    ]);
    await admin.query(
      `DELETE FROM workspaces WHERE workspace_id = ANY($1::uuid[])`,
      [[WS_A, WS_B, WS_C]]
    );
    await admin.query(`DELETE FROM tenants WHERE tenant_id = ANY($1::uuid[])`, [
      [TENANT_1, TENANT_2],
    ]);
    await dropRole();
  } catch (e) {
    console.error(`warn  cleanup: ${e.message}`);
  }
  await admin.end();
}

console.log(failed === 0 ? "=== PASS (rls-least-privilege) ===" : `=== FAIL (${failed}) ===`);
process.exit(failed === 0 ? 0 : 1);
