-- Dynamic schema (phase 1): let the extraction worker propose NEW entity
-- kinds it observes in your data, alongside the relation-type proposals the
-- schema_proposals table was built for. Promotion stays manual/gated — this
-- only widens what can be *proposed*.
--
-- The original CHECK allowed ('hyobject_subtype','relation_type'); add
-- 'entity_kind'. DROP + ADD makes the migration idempotent (re-running
-- converges to the same constraint).

ALTER TABLE schema_proposals
  DROP CONSTRAINT IF EXISTS schema_proposals_proposal_type_check;

ALTER TABLE schema_proposals
  ADD CONSTRAINT schema_proposals_proposal_type_check
  CHECK (proposal_type IN ('hyobject_subtype', 'relation_type', 'entity_kind'));
