-- Migration 027: THE-413 — Agent Graph Interconnection Pipeline
--
-- Expands relation_evidence and relation_feedback to support agent→agent edges.
-- Enables the graph to render connected agent nodes with evidence-backed edges.
--
-- Changes:
--   1. Add 'agent_agent' to relation_evidence.relation_kind CHECK constraint
--   2. Add 'agent_agent' to relation_feedback.relation_kind CHECK constraint
--   3. Add indexes for agent-scoped evidence queries

-- ============================================================
-- 1. relation_evidence: expand CHECK constraint to accept 'agent_agent'
-- ============================================================

-- Drop existing constraint (name is auto-generated, derive from pg_constraint)
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'relation_evidence'::regclass
    AND contype = 'c'
    AND conkey = ARRAY[3]::smallint[]  -- column position 3 is relation_kind
    AND pg_get_constraintdef(oid) LIKE '%relation_kind%';

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE relation_evidence DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE relation_evidence
  ADD CONSTRAINT relation_evidence_kind_check
  CHECK (relation_kind IN ('entity_relation', 'doc_relation', 'mention', 'agent_memory', 'agent_agent'));

-- ============================================================
-- 2. relation_feedback: expand CHECK constraint to accept 'agent_agent'
-- ============================================================

DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'relation_feedback'::regclass
    AND contype = 'c'
    AND conkey = ARRAY[3]::smallint[]  -- column position 3 is relation_kind
    AND pg_get_constraintdef(oid) LIKE '%relation_kind%';

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE relation_feedback DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE relation_feedback
  ADD CONSTRAINT relation_feedback_kind_check
  CHECK (relation_kind IN ('entity_relation', 'doc_relation', 'mention', 'agent_memory', 'agent_agent'));

-- ============================================================
-- 3. Index for agent-agent evidence queries
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_relation_evidence_agent_agent
  ON relation_evidence (workspace_id, source_node_id, target_node_id)
  WHERE relation_kind = 'agent_agent';

CREATE INDEX IF NOT EXISTS idx_relation_evidence_agent_memory
  ON relation_evidence (workspace_id, source_node_id, target_node_id)
  WHERE relation_kind = 'agent_memory';

-- ============================================================
-- 4. Index for agent-memory evidence by agent_id
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_relation_evidence_agent_memory_src
  ON relation_evidence (workspace_id, source_node_id)
  WHERE relation_kind = 'agent_memory';
