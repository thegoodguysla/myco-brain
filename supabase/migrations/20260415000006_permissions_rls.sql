-- Migration 006: Permissions table and Row Level Security

-- ============================================================
-- HYOBJECT PERMISSIONS
-- ============================================================
CREATE TABLE hyobject_permissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hyobject_id     uuid NOT NULL REFERENCES hyobjects(hyobject_id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspaces(workspace_id),
  principal_kind  text NOT NULL CHECK (principal_kind IN ('user','agent','role','workspace_member')),
  principal_id    text NOT NULL,
  can_read        boolean NOT NULL DEFAULT true,
  can_write       boolean NOT NULL DEFAULT false,
  can_share       boolean NOT NULL DEFAULT false
);

CREATE INDEX ON hyobject_permissions (workspace_id, hyobject_id);
CREATE INDEX ON hyobject_permissions (workspace_id, principal_kind, principal_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- Workspace isolation is the primary boundary.
-- The application sets app.workspace_id and app.principal_role
-- per connection/session via SET LOCAL.
-- ============================================================

ALTER TABLE workspaces           ENABLE ROW LEVEL SECURITY;
ALTER TABLE hyobjects            ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunks               ENABLE ROW LEVEL SECURITY;
ALTER TABLE people               ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities             ENABLE ROW LEVEL SECURITY;
ALTER TABLE hypeoplerelations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE peoplerelations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE relatedhyperdocuments ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_mentions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_relations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposed_entities    ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposed_relations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE hyobject_permissions ENABLE ROW LEVEL SECURITY;

-- Workspace isolation policy (app-level role sets app.workspace_id)
CREATE POLICY workspace_isolation ON hyobjects
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE POLICY workspace_isolation ON chunks
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE POLICY workspace_isolation ON people
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE POLICY workspace_isolation ON entities
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE POLICY workspace_isolation ON hypeoplerelations
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE POLICY workspace_isolation ON peoplerelations
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE POLICY workspace_isolation ON relatedhyperdocuments
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE POLICY workspace_isolation ON entity_mentions
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE POLICY workspace_isolation ON entity_relations
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE POLICY workspace_isolation ON proposed_entities
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE POLICY workspace_isolation ON proposed_relations
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE POLICY workspace_isolation ON hyobject_permissions
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- LLM role cannot see private hyobjects
-- The llm DB role only sees rows with sharing_type in (workspace, public, llm_readable)
CREATE POLICY llm_role_sharing_gate ON hyobjects
  AS RESTRICTIVE
  USING (
    current_setting('app.principal_role', true) <> 'llm'
    OR sharing_type_id IN (
      SELECT sharing_type_id FROM sharing_types
      WHERE name IN ('workspace', 'public', 'llm_readable')
    )
  );
