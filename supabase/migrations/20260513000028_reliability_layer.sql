-- Migration 028: THE-414 — Reliability Layer (Reconciliation, Replay, Dead-letter)
--
-- Adds:
--   1. processing_status + retry tracking on memory_write_events
--   2. memory_reconciliation_checks — audit trail for reconciliation runs
--   3. Indexes for reliability queries

-- ============================================================
-- 1. Extend memory_write_events with processing lifecycle
-- ============================================================
ALTER TABLE memory_write_events
  ADD COLUMN IF NOT EXISTS processing_status text NOT NULL DEFAULT 'completed'
    CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed', 'dead_lettered'));

ALTER TABLE memory_write_events
  ADD COLUMN IF NOT EXISTS processing_error text;

ALTER TABLE memory_write_events
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0;

ALTER TABLE memory_write_events
  ADD COLUMN IF NOT EXISTS processed_at timestamptz;

ALTER TABLE memory_write_events
  ADD COLUMN IF NOT EXISTS last_retry_at timestamptz;

ALTER TABLE memory_write_events
  ADD COLUMN IF NOT EXISTS dead_letter_reason text;

-- Index: find failed / dead-lettered events by workspace
CREATE INDEX IF NOT EXISTS idx_memory_write_events_failed
  ON memory_write_events (workspace_id, processing_status, created_at DESC)
  WHERE processing_status IN ('failed', 'dead_lettered');

-- Index: find events pending processing
CREATE INDEX IF NOT EXISTS idx_memory_write_events_pending
  ON memory_write_events (workspace_id, created_at ASC)
  WHERE processing_status = 'pending';

-- ============================================================
-- 2. Memory reconciliation checks — audit trail
-- ============================================================
CREATE TABLE IF NOT EXISTS memory_reconciliation_checks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  event_id         uuid REFERENCES memory_write_events(event_id) ON DELETE CASCADE,
  event_kind       text NOT NULL,
  expected_rows    jsonb NOT NULL DEFAULT '{}',
  actual_status    text NOT NULL
    CHECK (actual_status IN ('matched', 'missing', 'partial')),
  details          jsonb NOT NULL DEFAULT '{}',
  checked_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_checks_ws_time
  ON memory_reconciliation_checks (workspace_id, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_reconciliation_checks_ws_status
  ON memory_reconciliation_checks (workspace_id, actual_status);

-- ============================================================
-- 3. RLS for reliability tables
-- ============================================================
ALTER TABLE memory_reconciliation_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON memory_reconciliation_checks
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
