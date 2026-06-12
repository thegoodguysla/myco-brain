-- Full dynamic schema: corroboration counter for proposals. A type seen in
-- several independent documents earns auto-promotion (when the operator opts
-- in via BRAIN_SCHEMA_AUTO_PROMOTE); a one-off sighting never does.
-- source_hyobject_id tracks the LAST sighting's document so repeat sightings
-- from the same document don't inflate the count (see persistSchemaProposals).

ALTER TABLE schema_proposals
  ADD COLUMN IF NOT EXISTS seen_count int NOT NULL DEFAULT 1;
ALTER TABLE schema_proposals
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();
