-- Migration 025: Graph relation evidence + human feedback

CREATE TABLE relation_evidence (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(workspace_id),
  relation_kind      text NOT NULL CHECK (relation_kind IN ('entity_relation', 'doc_relation', 'mention', 'agent_memory')),
  relation_row_id    uuid,
  source_node_id     uuid NOT NULL,
  target_node_id     uuid NOT NULL,
  predicate          text,
  evidence_hyobject_id uuid REFERENCES hyobjects(hyobject_id) ON DELETE SET NULL,
  evidence_chunk_id  uuid REFERENCES chunks(chunk_id) ON DELETE SET NULL,
  confidence         numeric NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON relation_evidence (workspace_id, source_node_id, target_node_id);
CREATE INDEX ON relation_evidence (workspace_id, relation_kind);

CREATE TABLE relation_feedback (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(workspace_id),
  relation_kind      text NOT NULL CHECK (relation_kind IN ('entity_relation', 'doc_relation', 'mention', 'agent_memory')),
  source_node_id     uuid NOT NULL,
  target_node_id     uuid NOT NULL,
  predicate          text,
  verdict            text NOT NULL CHECK (verdict IN ('approve', 'reject', 'revise')),
  reason             text,
  submitted_by       text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON relation_feedback (workspace_id, source_node_id, target_node_id, created_at DESC);
CREATE INDEX ON relation_feedback (workspace_id, verdict, created_at DESC);

ALTER TABLE relation_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE relation_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON relation_evidence
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE POLICY workspace_isolation ON relation_feedback
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
