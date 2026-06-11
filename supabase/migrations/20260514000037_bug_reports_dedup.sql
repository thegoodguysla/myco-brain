-- Migration 037: THE-552 — Bug Intake Bridge dedup tracking
--
-- Adds bug_reports_dedup table for idempotent fallback recovery:
-- - dedup by fallback hyobject_id (primary bridge key)
-- - record linked Paperclip issue identifiers
-- - track title-key collisions without relying only on remote issue scans

BEGIN;

CREATE TABLE IF NOT EXISTS bug_reports_dedup (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                 uuid NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  fallback_hyobject_id         uuid NOT NULL REFERENCES hyobjects(hyobject_id) ON DELETE CASCADE,
  dedup_title_key              text NOT NULL,
  paperclip_issue_id           text,
  paperclip_issue_identifier   text,
  recovered_at                 timestamptz,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bug_reports_dedup_workspace_hyobject_unique UNIQUE (workspace_id, fallback_hyobject_id)
);

CREATE INDEX IF NOT EXISTS idx_bug_reports_dedup_workspace_title
  ON bug_reports_dedup (workspace_id, dedup_title_key);

CREATE INDEX IF NOT EXISTS idx_bug_reports_dedup_workspace_issue_identifier
  ON bug_reports_dedup (workspace_id, paperclip_issue_identifier);

CREATE INDEX IF NOT EXISTS idx_bug_reports_dedup_workspace_issue_id
  ON bug_reports_dedup (workspace_id, paperclip_issue_id);

CREATE OR REPLACE FUNCTION set_bug_reports_dedup_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_bug_reports_dedup_updated_at ON bug_reports_dedup;
CREATE TRIGGER set_bug_reports_dedup_updated_at
BEFORE UPDATE ON bug_reports_dedup
FOR EACH ROW
EXECUTE FUNCTION set_bug_reports_dedup_updated_at();

ALTER TABLE bug_reports_dedup ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'bug_reports_dedup'
      AND policyname = 'workspace_isolation'
  ) THEN
    CREATE POLICY workspace_isolation ON bug_reports_dedup
      USING (
        current_setting('app.workspace_id', true) IS NULL
        OR workspace_id = current_setting('app.workspace_id', true)::uuid
      );
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'bug_reports_dedup'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON bug_reports_dedup
      AS RESTRICTIVE
      USING (
        current_setting('app.tenant_id', true) IS NULL
        OR get_tenant_for_workspace(workspace_id) = current_setting('app.tenant_id', true)::uuid
      );
  END IF;
END;
$$;

COMMIT;
