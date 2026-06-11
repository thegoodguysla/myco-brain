-- Migration 011: v0.2 A3 — Identity resolution subsystem

CREATE TABLE identity_candidates (
  candidate_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(workspace_id),
  kind          text NOT NULL CHECK (kind IN ('person','entity')),
  a_id          uuid NOT NULL,
  b_id          uuid NOT NULL,
  score         numeric NOT NULL CHECK (score BETWEEN 0 AND 1),
  features      jsonb NOT NULL,   -- scoring signals: name similarity, shared edges, email, embedding sim
  state         text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','merged','rejected','held')),
  reviewed_by   uuid,
  reviewed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (a_id <> b_id)
);

CREATE INDEX ON identity_candidates (workspace_id, kind, state);
CREATE INDEX ON identity_candidates (workspace_id, a_id);
CREATE INDEX ON identity_candidates (workspace_id, b_id);

CREATE TABLE identity_merges (
  merge_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(workspace_id),
  kind              text NOT NULL CHECK (kind IN ('person','entity')),
  winner_id         uuid NOT NULL,
  loser_id          uuid NOT NULL,
  merged_by         text NOT NULL,
  merged_at         timestamptz NOT NULL DEFAULT now(),
  reversible_until  timestamptz,
  reason            text
);

CREATE INDEX ON identity_merges (workspace_id, kind, winner_id);
CREATE INDEX ON identity_merges (workspace_id, kind, loser_id);
