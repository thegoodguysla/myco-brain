-- Migration 032: THE-423B confidence accumulation upsert for agent-agent shared_trace
-- Enables ON CONFLICT upsert semantics for materialized shared_trace edges.

CREATE UNIQUE INDEX IF NOT EXISTS idx_relation_evidence_agent_agent_shared_trace_unique
  ON relation_evidence (workspace_id, relation_kind, source_node_id, target_node_id, predicate)
  WHERE relation_kind = 'agent_agent' AND predicate = 'shared_trace';
