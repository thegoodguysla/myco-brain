-- Migration 026: THE-409B — Memory write contract enforcement (idempotency + trace)
--
-- Adds:
--   1. memory_write_events — canonical append-only write log with idempotency guard
--   2. Trace lineage columns on agent_session_notes
--
-- Idempotency: (workspace_id, idempotency_key) is unique — replays are no-ops.
-- Trace: trace_id + span_id + causal_parent_id propagate across services.
-- Raw+Summary: raw_payload (jsonb) captures full event; summary is derived.

-- ============================================================
-- MEMORY WRITE EVENTS — canonical write log (append-only)
-- ============================================================
CREATE TABLE memory_write_events (
  event_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  agent_id          text NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  idempotency_key   text NOT NULL,
  trace_id          text NOT NULL,
  span_id           text NOT NULL,
  causal_parent_id  text,
  kind              text NOT NULL
    CHECK (kind IN ('save_memory','annotate','propose_fact','ingest')),
  raw_payload       jsonb NOT NULL,
  summary           text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX ON memory_write_events (workspace_id, created_at DESC);
CREATE INDEX ON memory_write_events (workspace_id, trace_id);
CREATE INDEX ON memory_write_events (workspace_id, agent_id, created_at DESC);

-- ============================================================
-- AGENT_SESSION_NOTES — agent_id (if missing) + trace lineage + raw/summary
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agent_session_notes' AND column_name = 'agent_id'
  ) THEN
    ALTER TABLE agent_session_notes
      ADD COLUMN agent_id text REFERENCES agents(agent_id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE agent_session_notes
  ADD COLUMN idempotency_key text,
  ADD COLUMN trace_id text,
  ADD COLUMN span_id text,
  ADD COLUMN causal_parent_id text,
  ADD COLUMN raw_payload jsonb,
  ADD COLUMN summary text;

CREATE INDEX ON agent_session_notes (workspace_id, agent_id)
  WHERE agent_id IS NOT NULL;
CREATE INDEX ON agent_session_notes (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX ON agent_session_notes (workspace_id, trace_id)
  WHERE trace_id IS NOT NULL;
