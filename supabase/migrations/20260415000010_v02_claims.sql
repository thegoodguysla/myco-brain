-- Migration 010: v0.2 A2 — Claims layer (contradiction handling)

CREATE TABLE claims (
  claim_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(workspace_id),
  subject_kind       text NOT NULL CHECK (subject_kind IN ('person','entity','hyobject')),
  subject_id         uuid NOT NULL,
  attribute          text NOT NULL,
  value              jsonb NOT NULL,
  source_hyobject_id uuid REFERENCES hyobjects(hyobject_id),
  extracted_by       text NOT NULL,
  confidence         numeric NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  valid_from         timestamptz,
  valid_to           timestamptz,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  superseded_by      uuid REFERENCES claims(claim_id),
  state              proposal_state NOT NULL DEFAULT 'pending'
);

CREATE INDEX ON claims (workspace_id, subject_kind, subject_id, attribute, recorded_at DESC);
CREATE INDEX ON claims (workspace_id, state);

-- Current best-claim view: highest confidence, most recent, not superseded
CREATE VIEW current_best_claims AS
  SELECT DISTINCT ON (workspace_id, subject_kind, subject_id, attribute)
    *
  FROM claims
  WHERE state IN ('auto_promoted', 'approved')
    AND superseded_by IS NULL
    AND (valid_to IS NULL OR valid_to > now())
  ORDER BY workspace_id, subject_kind, subject_id, attribute,
           confidence DESC, recorded_at DESC;
