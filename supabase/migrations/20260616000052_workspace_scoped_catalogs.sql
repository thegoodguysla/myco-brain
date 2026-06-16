-- Migration 052: workspace-scope the dynamic type catalogs.
--
-- Auto-promotion (BRAIN_SCHEMA_AUTO_PROMOTE=1) previously inserted a single
-- workspace's LLM-derived type NAMES into the GLOBAL entity_kinds /
-- relation_types catalogs, leaking one tenant's vocabulary to every other
-- workspace that reads them. This scopes promoted types to their workspace
-- while the canonical seed stays global (workspace_id IS NULL).
--
-- Enforcement lives in the read/write paths (extraction-worker reads
-- `workspace_id IS NULL OR workspace_id = <ws>`; schema-promotion writes the
-- owning workspace_id). Canonical rows MUST stay visible to every workspace,
-- which a per-row RLS policy can't express cleanly alongside the existing
-- tenant-isolation policies, so isolation is enforced in code, not RLS.

ALTER TABLE entity_kinds
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(workspace_id) ON DELETE CASCADE;
ALTER TABLE relation_types
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(workspace_id) ON DELETE CASCADE;

-- Replace the global UNIQUE(name) with: one canonical name (workspace_id NULL)
-- AND one name per (workspace_id, name) for workspace-scoped types.
ALTER TABLE entity_kinds   DROP CONSTRAINT IF EXISTS entity_kinds_name_key;
ALTER TABLE relation_types DROP CONSTRAINT IF EXISTS relation_types_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS entity_kinds_canonical_name_key
  ON entity_kinds (name) WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS entity_kinds_workspace_name_key
  ON entity_kinds (workspace_id, name) WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS relation_types_canonical_name_key
  ON relation_types (name) WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS relation_types_workspace_name_key
  ON relation_types (workspace_id, name) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS entity_kinds_workspace_idx   ON entity_kinds   (workspace_id);
CREATE INDEX IF NOT EXISTS relation_types_workspace_idx ON relation_types (workspace_id);

-- Allocate catalog ids from a sequence so concurrent promotion never collides
-- on a `max(id)+1` read (the previous allocation had no ON CONFLICT or lock).
CREATE SEQUENCE IF NOT EXISTS entity_kinds_kind_id_seq;
SELECT setval('entity_kinds_kind_id_seq',
              GREATEST(COALESCE((SELECT max(kind_id) FROM entity_kinds), 0), 1));
ALTER TABLE entity_kinds ALTER COLUMN kind_id SET DEFAULT nextval('entity_kinds_kind_id_seq');
ALTER SEQUENCE entity_kinds_kind_id_seq OWNED BY entity_kinds.kind_id;

CREATE SEQUENCE IF NOT EXISTS relation_types_relation_type_id_seq;
SELECT setval('relation_types_relation_type_id_seq',
              GREATEST(COALESCE((SELECT max(relation_type_id) FROM relation_types), 0), 1));
ALTER TABLE relation_types ALTER COLUMN relation_type_id SET DEFAULT nextval('relation_types_relation_type_id_seq');
ALTER SEQUENCE relation_types_relation_type_id_seq OWNED BY relation_types.relation_type_id;
