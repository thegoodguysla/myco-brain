-- Migration 029: THE-411 — Agent Identity Mapping + Binding API
--
-- Adds:
--   1. agent_bindings — stable mapping between Paperclip agent UUIDs and Myco Brain agent text IDs
--   2. Deterministic lookup: one binding per (workspace_id, paperclip_agent_id)
--   3. Queryable by agent and workspace
--
-- Design:
--   - Paperclip agents are identified by UUID (e.g. 3d67ab99-c0a8-4b14-bc7b-cb42b97a9e49)
--   - Myco Brain agents use a text agent_id in the agents table
--   - agent_bindings maps paperclip_agent_id ↔ brain_agent_id within a workspace
--   - Backfill-safe: existing agents can be bound by inserting rows into agent_bindings
--     with the brain_agent_id matching the existing agents.agent_id

-- ============================================================
-- AGENT BINDINGS — stable identity mapping
-- ============================================================
CREATE TABLE agent_bindings (
  binding_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  paperclip_agent_id    text NOT NULL,       -- Paperclip agent UUID
  brain_agent_id        text NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  paperclip_company_id  text,                -- Optional: scope binding to a Paperclip company
  platform              text NOT NULL DEFAULT 'paperclip'
    CHECK (platform IN ('paperclip', 'claude-code', 'cowork', 'other')),
  display_name          text,
  metadata              jsonb NOT NULL DEFAULT '{}',
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, paperclip_agent_id)
);

-- Lookup by paperclip_agent_id within a workspace
CREATE INDEX ON agent_bindings (workspace_id, paperclip_agent_id);

-- Lookup by brain_agent_id within a workspace
CREATE INDEX ON agent_bindings (workspace_id, brain_agent_id);

-- Cross-workspace lookup by paperclip_agent_id
CREATE INDEX ON agent_bindings (paperclip_agent_id);

-- Filter active bindings
CREATE INDEX ON agent_bindings (workspace_id, is_active)
  WHERE is_active = true;

-- ============================================================
-- Auto-update updated_at on row change
-- ============================================================
CREATE OR REPLACE FUNCTION agent_bindings_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_bindings_updated_at
  BEFORE UPDATE ON agent_bindings
  FOR EACH ROW
  EXECUTE FUNCTION agent_bindings_set_updated_at();
