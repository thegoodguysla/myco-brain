-- Migration 009: v0.2 A1 — Temporal modeling (bi-temporal facts)

ALTER TABLE hypeoplerelations
  ADD COLUMN valid_from  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN valid_to    timestamptz,
  ADD COLUMN recorded_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE entity_relations
  ADD COLUMN valid_from  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN valid_to    timestamptz,
  ADD COLUMN recorded_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE entity_mentions
  ADD COLUMN asserted_at timestamptz NOT NULL DEFAULT now();

-- Convenience index for current-state queries
CREATE INDEX ON hypeoplerelations (workspace_id, people_id, valid_to NULLS LAST);
CREATE INDEX ON entity_relations  (workspace_id, entity1_id, valid_to NULLS LAST);

-- Current-state helper views
CREATE VIEW current_hypeoplerelations AS
  SELECT * FROM hypeoplerelations
  WHERE valid_to IS NULL OR valid_to > now();

CREATE VIEW current_entity_relations AS
  SELECT * FROM entity_relations
  WHERE valid_to IS NULL OR valid_to > now();
