-- Migration 050: make RLS isolation policies empty-string-GUC safe.
--
-- ROOT CAUSE: the workspace_isolation / tenant_isolation / tenant_self_access
-- policies read the session context with current_setting('app.x', true) and
-- cast it ::uuid. A Postgres quirk: once set_config('app.x', …) has run in a
-- session (which withSession does on every call), that custom GUC is "defined"
-- for the session and thereafter returns '' (empty string) — NOT NULL — when
-- the local setting reverts. On a pooled/reused connection the next statement
-- then evaluates ''::uuid and ERRORS ("invalid input syntax for type uuid").
--
-- The default `brain` superuser never hits this because it BYPASSES RLS. But a
-- least-privilege (NOBYPASSRLS) application role — the role a multi-tenant /
-- agency deployment must use for isolation to actually bind — hits it on the
-- very first query, breaking search, ingest, stats, and the agent-binding
-- lookup. (Discovered while validating running the server under such a role.)
--
-- FIX: wrap every GUC read in NULLIF(current_setting('app.x', true), '') so an
-- empty string is treated exactly like NULL (no filter). Identical semantics
-- for NULL and a valid uuid; only the '' crash is removed. Idempotent.
--
-- CRITICAL: tenant_isolation MUST be recreated AS RESTRICTIVE (it was created
-- that way by migration 033). Postgres OR's permissive policies and AND's
-- restrictive ones, so the effective rule is "workspace_id matches (permissive)
-- AND tenant matches (restrictive)" — the workspace is the binding boundary and
-- two workspaces in the same tenant are isolated. `CREATE POLICY` defaults to
-- PERMISSIVE, so dropping + recreating tenant_isolation WITHOUT `AS RESTRICTIVE`
-- would silently turn the AND into an OR and break same-tenant workspace
-- isolation. workspace_isolation and tenant_self_access are permissive on
-- main and stay permissive here.

DO $$
DECLARE r record;
BEGIN
  -- workspace_isolation — every table filters by its workspace_id column.
  FOR r IN
    SELECT c.relname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE p.polname = 'workspace_isolation'
  LOOP
    EXECUTE format('DROP POLICY workspace_isolation ON %I', r.relname);
    EXECUTE format($f$
      CREATE POLICY workspace_isolation ON %I USING (
        NULLIF(current_setting('app.workspace_id', true), '') IS NULL
        OR workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      )$f$, r.relname);
  END LOOP;

  -- tenant_isolation — the workspaces table has its own tenant_id column; every
  -- other table resolves the tenant via get_tenant_for_workspace(workspace_id).
  FOR r IN
    SELECT c.relname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE p.polname = 'tenant_isolation'
  LOOP
    EXECUTE format('DROP POLICY tenant_isolation ON %I', r.relname);
    IF r.relname = 'workspaces' THEN
      EXECUTE format($f$
        CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (
          NULLIF(current_setting('app.tenant_id', true), '') IS NULL
          OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        )$f$, r.relname);
    ELSE
      EXECUTE format($f$
        CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (
          NULLIF(current_setting('app.tenant_id', true), '') IS NULL
          OR get_tenant_for_workspace(workspace_id) = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        )$f$, r.relname);
    END IF;
  END LOOP;

  -- tenant_self_access — the tenants table itself.
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'tenant_self_access') THEN
    EXECUTE 'DROP POLICY tenant_self_access ON tenants';
    EXECUTE $f$
      CREATE POLICY tenant_self_access ON tenants USING (
        NULLIF(current_setting('app.tenant_id', true), '') IS NULL
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      )$f$;
  END IF;
END $$;
