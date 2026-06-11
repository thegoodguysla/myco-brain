-- Migration 015: v0.2 A16 — Agent capability grants

CREATE TABLE agent_capabilities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     text NOT NULL REFERENCES agents(agent_id),
  workspace_id uuid NOT NULL REFERENCES workspaces(workspace_id),
  capability   text NOT NULL
    CHECK (capability IN ('read','propose','promote','admin','delete','ingest_private')),
  scope        jsonb NOT NULL DEFAULT '{}',
  granted_by   uuid NOT NULL,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz
);

CREATE INDEX ON agent_capabilities (workspace_id, agent_id);
CREATE INDEX ON agent_capabilities (workspace_id, capability);

-- Unique non-expiring grant per (agent, workspace, capability)
-- Note: Cannot use now() in partial index predicate (not IMMUTABLE).
-- Instead, enforce uniqueness on non-expiring grants; expiring grants
-- are deduplicated at the application layer.
CREATE UNIQUE INDEX ON agent_capabilities (agent_id, workspace_id, capability)
  WHERE expires_at IS NULL;
