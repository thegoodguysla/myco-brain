-- Migration 030: THE-414 — Idempotency key propagation + reconciliation fixes
--
-- 1. Add idempotency_key to proposed_entities & proposed_relations
--    Enables per-event reconciliation for propose_fact events.
--    Previously reconciliation was workspace-wide (any proposal = all matched).
-- 2. Add UNIQUE constraint on agent_session_notes (workspace_id, idempotency_key)
--    Enables explicit ON CONFLICT targets in replay — fails loudly if missing.
ALTER TABLE proposed_entities
  ADD COLUMN IF NOT EXISTS idempotency_key text;

ALTER TABLE proposed_relations
  ADD COLUMN IF NOT EXISTS idempotency_key text;

-- Indexes for reconciliation lookups by idempotency_key
CREATE INDEX IF NOT EXISTS idx_proposed_entities_idempotency
  ON proposed_entities (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_proposed_relations_idempotency
  ON proposed_relations (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Unique constraint on agent_session_notes for replay idempotency
-- The original ON CONFLICT DO NOTHING silently allowed duplicates without a
-- matching constraint. This makes replay idempotency explicit and loud.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_session_notes_workspace_id_idempotency_key_key'
  ) THEN
    ALTER TABLE agent_session_notes
      ADD CONSTRAINT agent_session_notes_workspace_id_idempotency_key_key
      UNIQUE (workspace_id, idempotency_key);
  END IF;
END $$;
