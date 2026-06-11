-- Migration 012: v0.2 A4 — Agent memory (sessions + session notes)

CREATE TABLE agent_sessions (
  session_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(workspace_id),
  agent_id      text NOT NULL REFERENCES agents(agent_id),
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  user_id       uuid,
  summary       text,
  metadata      jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX ON agent_sessions (workspace_id, agent_id);
CREATE INDEX ON agent_sessions (workspace_id, started_at DESC);

CREATE TABLE agent_session_notes (
  note_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(workspace_id),
  kind          text NOT NULL
    CHECK (kind IN ('observation','decision','question','fact')),
  content       text NOT NULL,
  embedding     vector(1536),
  promoted_to   uuid,   -- proposal_id or hyobject_id once promoted
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON agent_session_notes (session_id, created_at);
CREATE INDEX ON agent_session_notes (workspace_id, promoted_to) WHERE promoted_to IS NOT NULL;
CREATE INDEX ON agent_session_notes USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
