-- Migration 033: THE-430 — Tenant-level namespace isolation
--
-- Adds:
--   1. tenants table — top-level isolation boundary
--   2. tenant_id on workspaces — links workspace to tenant
--   3. get_tenant_for_workspace() helper — security definer for RLS policies
--   4. Updated RLS policies on all data tables — enforce tenant via helper
--   5. RLS enablement for tables that missed it
--   6. Default tenant backfill — existing workspaces assigned to default tenant
--
-- Design note: tenant_id is NOT denormalized into data tables.
-- Instead, RLS policies use get_tenant_for_workspace(workspace_id) to resolve
-- the tenant at query time. This avoids a 34-table schema change while providing
-- the same isolation guarantees. The function is STABLE (cached per-query) and
-- SECURITY DEFINER (bypasses workspaces RLS to read tenant_id).

-- ============================================================
-- 1. TENANTS TABLE
-- ============================================================
CREATE TABLE tenants (
  tenant_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  slug         text UNIQUE NOT NULL,
  status       text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'suspended')),
  settings     jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tenants_slug ON tenants (slug);
CREATE INDEX idx_tenants_status ON tenants (status);

-- ============================================================
-- 2. TENANT_ID + STATUS ON WORKSPACES
-- ============================================================
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(tenant_id);

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

-- Add constraint only if the column was just created (existing columns may already have it)
DO $$
BEGIN
  ALTER TABLE workspaces ADD CONSTRAINT workspaces_status_check
    CHECK (status IN ('active', 'inactive', 'archived', 'disabled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

-- Backfill any null status values (safety net)
UPDATE workspaces SET status = 'active' WHERE status IS NULL;

CREATE INDEX IF NOT EXISTS idx_workspaces_tenant ON workspaces (tenant_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces (status);

-- ============================================================
-- 3. DEFAULT TENANT + BACKFILL
-- ============================================================
INSERT INTO tenants (tenant_id, name, slug, status, settings)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Default Tenant',
  'default',
  'active',
  '{"is_default": true}'::jsonb
) ON CONFLICT (slug) DO NOTHING;

-- Assign all existing workspaces to the default tenant
UPDATE workspaces
SET tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE tenant_id IS NULL;

-- ============================================================
-- 4. TENANT RESOLUTION HELPER
-- ============================================================
CREATE OR REPLACE FUNCTION get_tenant_for_workspace(ws_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT tenant_id FROM workspaces WHERE workspace_id = ws_id;
$$;

-- ============================================================
-- 5. RLS ON TENANTS TABLE
-- ============================================================
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

-- Service role and owner can see all tenants; others see their own
CREATE POLICY tenant_self_access ON tenants
  USING (
    current_setting('app.tenant_id', true) IS NULL
    OR tenant_id = current_setting('app.tenant_id', true)::uuid
  );

-- ============================================================
-- 6. TENANT RLS ON WORKSPACES
-- ============================================================
DROP POLICY IF EXISTS workspace_isolation ON workspaces;

CREATE POLICY workspace_isolation ON workspaces
  USING (
    current_setting('app.workspace_id', true) IS NULL
    OR workspace_id = current_setting('app.workspace_id', true)::uuid
  );

-- Additional restrictive policy: must belong to the current tenant
CREATE POLICY tenant_isolation ON workspaces
  AS RESTRICTIVE
  USING (
    current_setting('app.tenant_id', true) IS NULL
    OR tenant_id = current_setting('app.tenant_id', true)::uuid
  );

-- ============================================================
-- 7. UPDATED RLS POLICIES ON ALL DATA TABLES
--
-- Each existing workspace_isolation policy gets a companion
-- tenant_isolation policy. The combined effect:
--   workspace_id must match app.workspace_id
--   AND the workspace's tenant must match app.tenant_id
-- When app.tenant_id is NULL (rollout compatibility), no tenant filter applies.
-- ============================================================

-- 7a. Tables that already have workspace_isolation policies
DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN (
        'hyobjects', 'chunks', 'people', 'entities',
        'hypeoplerelations', 'peoplerelations', 'relatedhyperdocuments',
        'entity_mentions', 'entity_relations',
        'proposed_entities', 'proposed_relations', 'hyobject_permissions',
        'ingestion_sources', 'source_category_rules',
        'memory_reconciliation_checks', 'agent_bindings',
        'memory_write_events', 'relation_evidence', 'relation_feedback'
      )
  LOOP
    -- Add tenant isolation policy if it doesn't exist
    EXECUTE format('
      DO $inner$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = ''public''
            AND tablename = %L
            AND policyname = ''tenant_isolation''
        ) THEN
          CREATE POLICY tenant_isolation ON %I
            AS RESTRICTIVE
            USING (
              current_setting(''app.tenant_id'', true) IS NULL
              OR get_tenant_for_workspace(workspace_id) = current_setting(''app.tenant_id'', true)::uuid
            );
        END IF;
      END;
      $inner$;
    ', tbl, tbl);
  END LOOP;
END;
$$;

-- ============================================================
-- 8. RLS ENABLEMENT ON TABLES THAT MISSED IT
-- ============================================================
ALTER TABLE agents                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain_queries            ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_sessions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_session_notes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_capabilities       ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_spend_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_budgets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_policies       ENABLE ROW LEVEL SECURITY;
ALTER TABLE deletion_requests        ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_candidates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_merges          ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_proposals         ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc                       ENABLE ROW LEVEL SECURITY;

-- 8a. Workspace isolation + tenant isolation for newly-RLS-enabled tables
DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN (
        'agents', 'brain_queries', 'claims', 'agent_sessions',
        'agent_session_notes', 'agent_capabilities',
        'llm_spend_events', 'workspace_budgets',
        'retention_policies', 'deletion_requests',
        'identity_candidates', 'identity_merges',
        'schema_proposals', 'vc'
      )
  LOOP
    -- Workspace isolation policy
    EXECUTE format('
      DO $inner$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = ''public''
            AND tablename = %L
            AND policyname = ''workspace_isolation''
        ) THEN
          CREATE POLICY workspace_isolation ON %I
            USING (
              current_setting(''app.workspace_id'', true) IS NULL
              OR workspace_id = current_setting(''app.workspace_id'', true)::uuid
            );
        END IF;
      END;
      $inner$;
    ', tbl, tbl);

    -- Tenant isolation policy
    EXECUTE format('
      DO $inner$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = ''public''
            AND tablename = %L
            AND policyname = ''tenant_isolation''
        ) THEN
          CREATE POLICY tenant_isolation ON %I
            AS RESTRICTIVE
            USING (
              current_setting(''app.tenant_id'', true) IS NULL
              OR get_tenant_for_workspace(workspace_id) = current_setting(''app.tenant_id'', true)::uuid
            );
        END IF;
      END;
      $inner$;
    ', tbl, tbl);
  END LOOP;
END;
$$;

-- ============================================================
-- 9. TENANT_ID NOT NULL ON WORKSPACES (enforce after backfill)
-- ============================================================
ALTER TABLE workspaces
  ALTER COLUMN tenant_id SET NOT NULL;

-- ============================================================
-- 10. TRIGGER: auto-set tenant_id on new workspaces
-- Default new workspaces to the default tenant unless specified
-- ============================================================
CREATE OR REPLACE FUNCTION set_default_tenant()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    NEW.tenant_id := '00000000-0000-0000-0000-000000000001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspaces_default_tenant
  BEFORE INSERT ON workspaces
  FOR EACH ROW
  WHEN (NEW.tenant_id IS NULL)
  EXECUTE FUNCTION set_default_tenant();
