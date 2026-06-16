-- Migration 053: count schema-proposal seen_count from DISTINCT source documents.
--
-- Previously seen_count incremented whenever a sighting's source differed from
-- the LAST stored source, so two documents alternating (A, B, A) could reach the
-- promotion gate (seen_count >= 3) with only TWO distinct sources. Track the real
-- distinct-source set so the corroboration gate counts documents, not sightings.

CREATE TABLE IF NOT EXISTS schema_proposal_sources (
  proposal_id        uuid NOT NULL REFERENCES schema_proposals(id) ON DELETE CASCADE,
  source_hyobject_id uuid NOT NULL,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, source_hyobject_id)
);
CREATE INDEX IF NOT EXISTS schema_proposal_sources_proposal_idx
  ON schema_proposal_sources (proposal_id);

-- Backfill: each existing proposal's recorded source counts as one distinct
-- source, then recompute seen_count from the set (floor 1).
INSERT INTO schema_proposal_sources (proposal_id, source_hyobject_id)
SELECT id, source_hyobject_id FROM schema_proposals
 WHERE source_hyobject_id IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE schema_proposals sp
   SET seen_count = GREATEST(1, (
     SELECT count(*) FROM schema_proposal_sources s WHERE s.proposal_id = sp.id
   ));
