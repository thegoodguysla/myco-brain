-- Migration 008: Agent registry and query logs

-- ============================================================
-- AGENTS
-- ============================================================
CREATE TABLE agents (
  agent_id      text PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(workspace_id),
  platform      text NOT NULL CHECK (platform IN ('paperclip','claude-code','cowork','other')),
  display_name  text,
  permissions   jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON agents (workspace_id);

-- ============================================================
-- BRAIN QUERIES (MCP call log)
-- ============================================================
CREATE TABLE brain_queries (
  query_id    bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(workspace_id),
  agent_id    text REFERENCES agents(agent_id),
  tool_name   text NOT NULL,
  input       jsonb NOT NULL,
  output_hash text,
  latency_ms  int,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON brain_queries (workspace_id, created_at DESC);
CREATE INDEX ON brain_queries (workspace_id, agent_id, created_at DESC);
