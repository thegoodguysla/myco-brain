-- Migration 040: Create chunk_extraction_status table
-- Tracks per-chunk extraction lifecycle with tenant-aware RLS.

CREATE TABLE chunk_extraction_status (
  chunk_id         uuid PRIMARY KEY REFERENCES chunks(chunk_id) ON DELETE CASCADE,
  workspace_id     uuid NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
  attempts         int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error       text,
  extracted_at     timestamptz,
  metadata         jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_chunk_extraction_status_workspace_status
  ON chunk_extraction_status (workspace_id, status);

CREATE INDEX idx_chunk_extraction_status_updated_at
  ON chunk_extraction_status (updated_at DESC);

-- Backfill existing chunks so extraction worker can process historical data.
INSERT INTO chunk_extraction_status (chunk_id, workspace_id, status, attempts, metadata)
SELECT c.chunk_id, c.workspace_id, 'pending', 0, jsonb_build_object('seeded_by', 'migration_040')
  FROM chunks c
ON CONFLICT (chunk_id) DO NOTHING;

CREATE TRIGGER chunk_extraction_status_set_updated_at
  BEFORE UPDATE ON chunk_extraction_status
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE chunk_extraction_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON chunk_extraction_status
  USING (
    current_setting('app.workspace_id', true) IS NULL
    OR workspace_id = current_setting('app.workspace_id', true)::uuid
  );

CREATE POLICY tenant_isolation ON chunk_extraction_status
  AS RESTRICTIVE
  USING (
    current_setting('app.tenant_id', true) IS NULL
    OR get_tenant_for_workspace(workspace_id) = current_setting('app.tenant_id', true)::uuid
  );
