-- Migration 014: v0.2 A8 — Retention policies and deletion requests

CREATE TABLE retention_policies (
  policy_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(workspace_id),
  applies_to   text NOT NULL,  -- 'person'|'hyobject_type'|'tag'|...
  criteria     jsonb NOT NULL,
  action       text NOT NULL CHECK (action IN ('soft_delete','hard_delete','anonymize')),
  after_days   int,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON retention_policies (workspace_id);

CREATE TABLE deletion_requests (
  request_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(workspace_id),
  target_kind   text NOT NULL,
  target_id     uuid NOT NULL,
  requested_by  uuid NOT NULL,
  reason        text,
  state         text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','executed','denied')),
  cascaded_rows jsonb,
  executed_at   timestamptz
);

CREATE INDEX ON deletion_requests (workspace_id, state);
CREATE INDEX ON deletion_requests (workspace_id, target_kind, target_id);
