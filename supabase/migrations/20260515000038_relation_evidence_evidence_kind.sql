-- Migration 038: Add evidence_kind classification to relation_evidence
--
-- Adds a lightweight discriminator so consumers can distinguish evidence
-- produced directly from source events vs synthesized rollups.

ALTER TABLE relation_evidence
  ADD COLUMN IF NOT EXISTS evidence_kind text NOT NULL DEFAULT 'unspecified';

CREATE INDEX IF NOT EXISTS idx_relation_evidence_workspace_evidence_kind
  ON relation_evidence (workspace_id, evidence_kind);
