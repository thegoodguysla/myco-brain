-- Migration 005: Proposals layer (aggressive-extraction buffer)

CREATE TYPE proposal_state AS ENUM ('pending', 'auto_promoted', 'approved', 'rejected', 'shelved');

-- ============================================================
-- PROPOSED ENTITIES
-- ============================================================
CREATE TABLE proposed_entities (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(workspace_id),
  kind_id             int NOT NULL REFERENCES entity_kinds(kind_id),
  canonical_name      text NOT NULL,
  aliases             text[] NOT NULL DEFAULT '{}',
  source_hyobject_id  uuid NOT NULL REFERENCES hyobjects(hyobject_id),
  extracted_by        text NOT NULL,  -- 'llm:claude-3-5-sonnet:prompt-hash-v1' or 'program:ner-spacy-v1'
  confidence          numeric NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  state               proposal_state NOT NULL DEFAULT 'pending',
  promoted_entity_id  uuid REFERENCES entities(entity_id),
  reviewed_by         uuid,
  reviewed_at         timestamptz,
  rejection_reason    text,
  correction          jsonb,          -- what the right answer would have been (feeds prompt improvement)
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON proposed_entities (workspace_id, state);
CREATE INDEX ON proposed_entities (workspace_id, kind_id, state);

-- ============================================================
-- PROPOSED RELATIONS
-- ============================================================
CREATE TABLE proposed_relations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(workspace_id),
  subject_kind        text NOT NULL CHECK (subject_kind IN ('hyobject','person','entity')),
  subject_id          uuid NOT NULL,
  object_kind         text NOT NULL CHECK (object_kind IN ('hyobject','person','entity')),
  object_id           uuid NOT NULL,
  relation_type_id    int REFERENCES relation_types(relation_type_id),
  predicate           text,           -- for entity-entity free-text predicates
  source_hyobject_id  uuid REFERENCES hyobjects(hyobject_id),
  extracted_by        text NOT NULL,
  confidence          numeric NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  state               proposal_state NOT NULL DEFAULT 'pending',
  reviewed_by         uuid,
  reviewed_at         timestamptz,
  rejection_reason    text,
  correction          jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON proposed_relations (workspace_id, state);
CREATE INDEX ON proposed_relations (workspace_id, subject_kind, subject_id, state);
