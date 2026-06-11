-- ============================================================
-- SEED: reference type catalog + default local workspace/agent
-- ============================================================
-- Purpose: make `docker compose up` immediately usable for the
-- quickstart's five demos. Without this, a fresh boot has:
--   1. empty reference tables (hyobject_types, subtypes, sharing_types,
--      entity_kinds) — so EVERY brain.ingest / brain.save_memory call
--      fails with a foreign-key violation (hyobjects_type_id_fkey), and
--   2. zero workspaces — so the first tool call fails with
--      "Workspace not found", and the literal "default" string the docs
--      use is not a valid uuid for app.workspace_id.
--
-- The type ids below are the canonical values the server + workers
-- already hardcode (see mcp-server save_memory type_id=80/subtype=200,
-- ingest defaults type_id=1/subtype=1/sharing=2, ingestion writer
-- _TYPE_MAP/_SUBTYPE_MAP, connectors db.py TYPE_* constants). Keep this
-- in sync with the authoritative production seed.sql.
--
-- Quickstart / Claude Desktop config must use:
--   BRAIN_WORKSPACE_ID = 00000000-0000-0000-0000-000000000001
--   BRAIN_API_KEY      = brain_00000000-0000-0000-0000-000000000001_00000000-0000-0000-0000-0000000000a1_localdev
--                        (format: brain_<workspaceId>_<agentId>_<secret>)
-- NOTE: agentId must be a UUID. save_memory materializes an agent->memory
-- edge into relation_evidence.source_node_id, which is uuid NOT NULL, so a
-- non-uuid agent_id (e.g. "default") fails. Keep the agent_id a real uuid.
--
-- Idempotent: safe to re-run. Local/self-hosted use only.

-- ── Reference: sharing types ────────────────────────────────────────────────
INSERT INTO sharing_types (sharing_type_id, name) VALUES
  (1, 'private'),
  (2, 'workspace'),
  (3, 'org'),
  (4, 'public'),
  (5, 'llm_readable')
ON CONFLICT (sharing_type_id) DO NOTHING;

-- ── Reference: hyobject types ───────────────────────────────────────────────
INSERT INTO hyobject_types (type_id, name, description) VALUES
  (1,  'File',        'Generic file or uncategorised object'),
  (2,  'Email',       'Email message'),
  (3,  'Document',    'Document (docx, xlsx, pptx, etc.)'),
  (4,  'Note',        'Plain text note'),
  (5,  'PDF',         'PDF document'),
  (9,  'WebPage',     'Web page or URL'),
  (80, 'AgentAction', 'An agent action / memory record')
ON CONFLICT (type_id) DO NOTHING;

-- ── Reference: hyobject subtypes ────────────────────────────────────────────
INSERT INTO hyobject_subtypes (subtype_id, name, description) VALUES
  (1,   'Generic',      'Generic subtype'),
  (2,   'JustIndexed',  'Ingested and indexed, no advisory subtype yet'),
  (17,  'Presentation', 'Presentation document'),
  (18,  'Spreadsheet',  'Spreadsheet document'),
  (200, 'Action',       'Agent action subtype')
ON CONFLICT (subtype_id) DO NOTHING;

-- ── Reference: entity kinds ─────────────────────────────────────────────────
INSERT INTO entity_kinds (kind_id, name) VALUES
  (1, 'organization'),
  (2, 'person'),
  (3, 'project'),
  (4, 'location')
ON CONFLICT (kind_id) DO NOTHING;

-- ── Reference: embedding model (FK target for chunks_openai3small) ───────────
INSERT INTO embedding_models (model_id, dimension, active) VALUES
  ('openai-3-small', 1536, true)
ON CONFLICT (model_id) DO NOTHING;

-- ── Default local workspace + agent ─────────────────────────────────────────
INSERT INTO workspaces (workspace_id, name, slug, plan, status, settings)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Default',
  'default',
  'free',
  'active',
  '{"provisioning_source": "oss_quickstart_seed"}'::jsonb
)
ON CONFLICT (workspace_id) DO NOTHING;

INSERT INTO agents (agent_id, workspace_id, platform, display_name)
VALUES (
  '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-000000000001',
  'other',
  'Default Local Agent'
)
ON CONFLICT (agent_id) DO NOTHING;
