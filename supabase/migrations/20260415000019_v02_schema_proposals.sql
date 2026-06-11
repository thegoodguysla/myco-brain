-- Migration 019: v0.2 — Schema Designer proposals

-- Track which hyobjects have been analyzed for schema proposals
ALTER TABLE hyobjects ADD COLUMN IF NOT EXISTS schema_analyzed_at timestamptz;

-- ============================================================
-- SCHEMA PROPOSALS
-- Stores LLM-proposed additions to hyobject_subtypes and relation_types.
-- High-confidence proposals are auto-applied; medium sit here for review.
-- ============================================================
CREATE TABLE schema_proposals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(workspace_id),
  -- 'hyobject_subtype' or 'relation_type'
  proposal_type      text NOT NULL CHECK (proposal_type IN ('hyobject_subtype', 'relation_type')),
  name               text NOT NULL,
  description        text,
  -- relation_type fields (ignored for subtype proposals)
  is_symmetric       boolean NOT NULL DEFAULT false,
  -- The document that triggered this proposal (NULL for seed-based proposals)
  source_hyobject_id uuid REFERENCES hyobjects(hyobject_id),
  extracted_by       text NOT NULL,
  confidence         numeric NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  state              proposal_state NOT NULL DEFAULT 'pending',
  -- Set to the subtype_id / relation_type_id after auto-promotion
  applied_id         int,
  reviewed_by        uuid,
  reviewed_at        timestamptz,
  rejection_reason   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- Deduplicate proposals per workspace per type+name
  UNIQUE (workspace_id, proposal_type, name)
);

CREATE INDEX ON schema_proposals (workspace_id, state);
CREATE INDEX ON schema_proposals (workspace_id, proposal_type, state);
