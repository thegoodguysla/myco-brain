-- Migration 039: THE-558 — Canonical relations materialized view
--
-- Unifies all relation tables into one normalized surface for traversal,
-- analytics, and downstream APIs.

DROP MATERIALIZED VIEW IF EXISTS canon_relations;

CREATE MATERIALIZED VIEW canon_relations AS
SELECT
  hpr.workspace_id,
  hpr.id AS relation_id,
  'person_hyobject'::text AS relation_kind,
  'person'::text AS source_kind,
  hpr.people_id AS source_id,
  'hyobject'::text AS target_kind,
  hpr.hyobject_id AS target_id,
  rt.name AS predicate,
  hpr.relation_type_id,
  hpr.source_hyobject_id,
  hpr.confidence,
  NULL::jsonb AS metadata,
  hpr.valid_from,
  hpr.valid_to,
  hpr.recorded_at,
  hpr.created_at
FROM hypeoplerelations hpr
JOIN relation_types rt ON rt.relation_type_id = hpr.relation_type_id

UNION ALL

SELECT
  pr.workspace_id,
  pr.id AS relation_id,
  'person_person'::text AS relation_kind,
  'person'::text AS source_kind,
  pr.people1_id AS source_id,
  'person'::text AS target_kind,
  pr.people2_id AS target_id,
  rt.name AS predicate,
  pr.relation_type_id,
  pr.source_hyobject_id,
  pr.confidence,
  pr.metadata,
  pr.begin_date::timestamptz AS valid_from,
  pr.end_date::timestamptz AS valid_to,
  pr.created_at AS recorded_at,
  pr.created_at
FROM peoplerelations pr
JOIN relation_types rt ON rt.relation_type_id = pr.relation_type_id

UNION ALL

SELECT
  rhd.workspace_id,
  rhd.id AS relation_id,
  'hyobject_hyobject'::text AS relation_kind,
  'hyobject'::text AS source_kind,
  rhd.hyobject1_id AS source_id,
  'hyobject'::text AS target_kind,
  rhd.hyobject2_id AS target_id,
  rt.name AS predicate,
  rhd.relation_type_id,
  NULL::uuid AS source_hyobject_id,
  rhd.confidence,
  jsonb_build_object(
    'description', rhd.description,
    'priority', rhd.priority
  ) AS metadata,
  rhd.created_at AS valid_from,
  NULL::timestamptz AS valid_to,
  rhd.created_at AS recorded_at,
  rhd.created_at
FROM relatedhyperdocuments rhd
JOIN relation_types rt ON rt.relation_type_id = rhd.relation_type_id

UNION ALL

SELECT
  er.workspace_id,
  er.id AS relation_id,
  'entity_entity'::text AS relation_kind,
  'entity'::text AS source_kind,
  er.entity1_id AS source_id,
  'entity'::text AS target_kind,
  er.entity2_id AS target_id,
  er.predicate,
  NULL::int AS relation_type_id,
  er.source_hyobject_id,
  er.confidence,
  NULL::jsonb AS metadata,
  er.valid_from,
  er.valid_to,
  er.recorded_at,
  er.created_at
FROM entity_relations er;

CREATE UNIQUE INDEX idx_canon_relations_kind_id
  ON canon_relations (relation_kind, relation_id);

CREATE INDEX idx_canon_relations_workspace
  ON canon_relations (workspace_id);

CREATE INDEX idx_canon_relations_workspace_source
  ON canon_relations (workspace_id, source_kind, source_id);

CREATE INDEX idx_canon_relations_workspace_target
  ON canon_relations (workspace_id, target_kind, target_id);

CREATE INDEX idx_canon_relations_workspace_predicate
  ON canon_relations (workspace_id, predicate);

CREATE INDEX idx_canon_relations_workspace_valid_to
  ON canon_relations (workspace_id, valid_to NULLS LAST);
