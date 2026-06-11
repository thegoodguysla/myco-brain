-- Migration 003: Core object tables — hyobjects, chunks, people, entities

-- ============================================================
-- HYOBJECTS (core "anything" table)
-- ============================================================
CREATE TABLE hyobjects (
  hyobject_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  type_id                int NOT NULL REFERENCES hyobject_types(type_id),
  subtype_id             int NOT NULL REFERENCES hyobject_subtypes(subtype_id),
  name                   text,
  description            text,            -- LLM-advisory only
  sharing_type_id        int NOT NULL REFERENCES sharing_types(sharing_type_id) DEFAULT 1,
  -- deterministic fields — LLM must never write these
  storage_uri            text,
  mime_type              text,
  byte_size              bigint,
  sha256                 text,
  page_count             int,
  duration_seconds       numeric,
  width                  int,
  height                 int,
  author_from_metadata   text,
  language               text,
  created_from_source_at timestamptz,
  -- bookkeeping
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  processing_state       text NOT NULL DEFAULT 'pending_deterministic'
    CHECK (processing_state IN ('pending_deterministic','pending_llm','done','error','redacted')),
  content_tsv            tsvector,
  UNIQUE (workspace_id, sha256)
);

CREATE INDEX ON hyobjects (workspace_id, type_id, subtype_id);
CREATE INDEX ON hyobjects USING gin (content_tsv);
CREATE INDEX ON hyobjects (workspace_id, processing_state);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER hyobjects_set_updated_at
  BEFORE UPDATE ON hyobjects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- CHUNKS (for embeddings + retrieval)
-- ============================================================
CREATE TABLE chunks (
  chunk_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hyobject_id    uuid NOT NULL REFERENCES hyobjects(hyobject_id) ON DELETE CASCADE,
  workspace_id   uuid NOT NULL REFERENCES workspaces(workspace_id),
  chunk_index    int NOT NULL,
  text           text NOT NULL,
  token_count    int,
  embedding      vector(1536),   -- OpenAI text-embedding-3-small; see migration 015 for pluggable embeddings
  metadata       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hyobject_id, chunk_index)
);

CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON chunks (hyobject_id, chunk_index);
CREATE INDEX ON chunks (workspace_id);

-- ============================================================
-- PEOPLE
-- ============================================================
CREATE TABLE people (
  people_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(workspace_id),
  firstname         text,
  lastname          text,
  display_name      text,
  primary_email     text,
  begin_date        date,
  end_date          date,
  do_not_contact    boolean NOT NULL DEFAULT false,
  sales_flow_stage  text,
  lead_source       text,
  metadata          jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON people (workspace_id, primary_email);
CREATE INDEX ON people (workspace_id, lastname, firstname);
CREATE INDEX ON people USING gin (lastname gin_trgm_ops);

-- ============================================================
-- ENTITIES (abstract: companies, projects, concepts, places, topics)
-- ============================================================
CREATE TABLE entity_kinds (
  kind_id    int PRIMARY KEY,
  name       text UNIQUE NOT NULL
);

CREATE TABLE entities (
  entity_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(workspace_id),
  kind_id        int NOT NULL REFERENCES entity_kinds(kind_id),
  canonical_name text NOT NULL,
  aliases        text[] NOT NULL DEFAULT '{}',
  description    text,
  metadata       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON entities (workspace_id, kind_id);
CREATE INDEX ON entities USING gin (aliases);
CREATE INDEX ON entities USING gin (canonical_name gin_trgm_ops);
