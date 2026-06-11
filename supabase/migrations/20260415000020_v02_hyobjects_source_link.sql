-- Migration 020: Add source_id to hyobjects for per-source progress tracking

ALTER TABLE hyobjects ADD COLUMN IF NOT EXISTS source_id uuid
  REFERENCES ingestion_sources(source_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_hyobjects_workspace_source
  ON hyobjects (workspace_id, source_id)
  WHERE source_id IS NOT NULL;
