-- Migration 004: Three-edge relationship tables

-- ============================================================
-- Person ↔ Hyobject
-- ============================================================
CREATE TABLE hypeoplerelations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(workspace_id),
  people_id         uuid NOT NULL REFERENCES people(people_id) ON DELETE CASCADE,
  hyobject_id       uuid NOT NULL REFERENCES hyobjects(hyobject_id) ON DELETE CASCADE,
  relation_type_id  int NOT NULL REFERENCES relation_types(relation_type_id),
  source_hyobject_id uuid REFERENCES hyobjects(hyobject_id),
  confidence        numeric NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON hypeoplerelations (workspace_id, people_id);
CREATE INDEX ON hypeoplerelations (workspace_id, hyobject_id);

-- ============================================================
-- Person ↔ Person
-- ============================================================
CREATE TABLE peoplerelations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(workspace_id),
  people1_id        uuid NOT NULL REFERENCES people(people_id) ON DELETE CASCADE,
  people2_id        uuid NOT NULL REFERENCES people(people_id) ON DELETE CASCADE,
  relation_type_id  int NOT NULL REFERENCES relation_types(relation_type_id),
  begin_date        date,
  end_date          date,
  source_hyobject_id uuid REFERENCES hyobjects(hyobject_id),
  confidence        numeric NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  metadata          jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (people1_id <> people2_id)
);

CREATE INDEX ON peoplerelations (workspace_id, people1_id);
CREATE INDEX ON peoplerelations (workspace_id, people2_id);

-- ============================================================
-- Hyobject ↔ Hyobject
-- ============================================================
CREATE TABLE relatedhyperdocuments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(workspace_id),
  hyobject1_id      uuid NOT NULL REFERENCES hyobjects(hyobject_id) ON DELETE CASCADE,
  hyobject2_id      uuid NOT NULL REFERENCES hyobjects(hyobject_id) ON DELETE CASCADE,
  relation_type_id  int NOT NULL REFERENCES relation_types(relation_type_id),
  description       text,
  priority          int NOT NULL DEFAULT 0,
  confidence        numeric NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (hyobject1_id <> hyobject2_id)
);

CREATE INDEX ON relatedhyperdocuments (workspace_id, hyobject1_id);
CREATE INDEX ON relatedhyperdocuments (workspace_id, hyobject2_id);

-- ============================================================
-- Entity ↔ Hyobject (mentions/instances)
-- ============================================================
CREATE TABLE entity_mentions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(workspace_id),
  entity_id         uuid NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
  hyobject_id       uuid NOT NULL REFERENCES hyobjects(hyobject_id) ON DELETE CASCADE,
  chunk_id          uuid REFERENCES chunks(chunk_id),
  span_start        int,
  span_end          int,
  confidence        numeric NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON entity_mentions (workspace_id, entity_id);
CREATE INDEX ON entity_mentions (workspace_id, hyobject_id);

-- ============================================================
-- Entity ↔ Entity (knowledge-graph traversal)
-- ============================================================
CREATE TABLE entity_relations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(workspace_id),
  entity1_id        uuid NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
  entity2_id        uuid NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
  predicate         text NOT NULL,
  source_hyobject_id uuid REFERENCES hyobjects(hyobject_id),
  confidence        numeric NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (entity1_id <> entity2_id)
);

CREATE INDEX ON entity_relations (workspace_id, entity1_id);
CREATE INDEX ON entity_relations (workspace_id, entity2_id);
