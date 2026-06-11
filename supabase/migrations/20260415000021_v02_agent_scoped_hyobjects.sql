-- Migration 021: v0.2 — Agent-scoped hyobjects (agent memory / sub-brain)
--
-- Adds agent_id to hyobjects so agents can own documents and memory chunks.
-- Agent-scoped hyobjects are globally searchable but filterable to a specific agent,
-- enabling per-agent sub-brains within the shared Myco knowledge graph.

-- Add agent_id column to hyobjects
ALTER TABLE hyobjects
  ADD COLUMN agent_id text REFERENCES agents(agent_id) ON DELETE SET NULL;

-- Index for agent-scoped queries
CREATE INDEX ON hyobjects (workspace_id, agent_id)
  WHERE agent_id IS NOT NULL;

-- Index for recent agent documents
CREATE INDEX ON hyobjects (workspace_id, agent_id, created_at DESC)
  WHERE agent_id IS NOT NULL;
