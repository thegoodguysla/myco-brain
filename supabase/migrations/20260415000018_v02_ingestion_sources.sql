-- Migration 018: v0.2 — Ingestion source profiles and category rules

-- ============================================================
-- INGESTION SOURCES
-- Tracks per-workspace data source connections (e.g. Gmail, Drive,
-- Slack, Notion) and their default classification settings.
-- ============================================================
CREATE TABLE ingestion_sources (
  source_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  name               text NOT NULL,
  provider           text NOT NULL,
  composio_conn_id   text,
  category_tag       text,
  filters            jsonb NOT NULL DEFAULT '{}',
  privacy_default    text NOT NULL DEFAULT 'workspace'
    CHECK (privacy_default IN ('private','workspace','org','public','llm_readable')),
  sync_frequency     text NOT NULL DEFAULT 'hourly'
    CHECK (sync_frequency IN ('realtime','hourly','daily','weekly','manual')),
  last_synced_at     timestamptz,
  status             text NOT NULL DEFAULT 'pending_setup'
    CHECK (status IN ('pending_setup','active','paused','error','disconnected')),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON ingestion_sources (workspace_id, provider);
CREATE INDEX ON ingestion_sources (workspace_id, status);
CREATE INDEX ON ingestion_sources (workspace_id, source_id);

-- ============================================================
-- SOURCE CATEGORY RULES
-- Pattern-matched classification rules scoped to a source.
-- Rules are evaluated in priority order (ascending); first match wins.
-- match_pattern supports field equality checks, e.g.:
--   {"mime_type": "application/pdf"}
--   {"name_contains": "invoice", "mime_type": "text/plain"}
-- An empty match_pattern {} matches all objects from the source.
-- ============================================================
CREATE TABLE source_category_rules (
  rule_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id      uuid NOT NULL REFERENCES ingestion_sources(source_id) ON DELETE CASCADE,
  workspace_id   uuid NOT NULL,
  match_pattern  jsonb NOT NULL,
  category_tag   text NOT NULL,
  subtype_hint   int REFERENCES hyobject_subtypes(subtype_id),
  entity_hints   jsonb NOT NULL DEFAULT '[]',
  priority       int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON source_category_rules (source_id, priority);
CREATE INDEX ON source_category_rules (workspace_id, source_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE ingestion_sources    ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_category_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON ingestion_sources
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE POLICY workspace_isolation ON source_category_rules
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- ============================================================
-- VC AUDIT TRIGGERS
-- ============================================================
CREATE TRIGGER audit_ingestion_sources
  AFTER INSERT OR UPDATE OR DELETE ON ingestion_sources
  FOR EACH ROW EXECUTE FUNCTION audit_row_changes();

CREATE TRIGGER audit_source_category_rules
  AFTER INSERT OR UPDATE OR DELETE ON source_category_rules
  FOR EACH ROW EXECUTE FUNCTION audit_row_changes();
