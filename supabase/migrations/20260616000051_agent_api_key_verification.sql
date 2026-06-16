-- Migration 051: Optional server-side verification of BRAIN_API_KEY secrets
--
-- Before this migration, brain_<workspace>_<agent>_<secret> keys were trusted
-- based on workspace/agent segments only; the secret segment was opaque.
--
-- This migration adds a backwards-compatible key registry:
--   - if a row exists in agent_api_keys for (workspace_id, agent_id), the
--     server verifies the presented secret against secret_hash.
--   - if no row exists, legacy behavior is preserved unless
--     BRAIN_REQUIRE_API_KEY_SECRET=1 is enabled in the server env.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS agent_api_keys (
  workspace_id  uuid NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  agent_id      text NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  secret_hash   text NOT NULL,
  key_label     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  PRIMARY KEY (workspace_id, agent_id),
  CHECK (length(secret_hash) > 0)
);

CREATE INDEX IF NOT EXISTS idx_agent_api_keys_workspace_last_used
  ON agent_api_keys (workspace_id, last_used_at DESC);

CREATE OR REPLACE FUNCTION brain_set_agent_api_key_secret(
  p_workspace_id uuid,
  p_agent_id text,
  p_secret text,
  p_key_label text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_secret IS NULL OR length(trim(p_secret)) = 0 THEN
    RAISE EXCEPTION 'API key secret must be non-empty';
  END IF;

  INSERT INTO agent_api_keys (workspace_id, agent_id, secret_hash, key_label)
  VALUES (
    p_workspace_id,
    p_agent_id,
    crypt(p_secret, gen_salt('bf', 12)),
    p_key_label
  )
  ON CONFLICT (workspace_id, agent_id)
  DO UPDATE SET
    secret_hash = EXCLUDED.secret_hash,
    key_label = COALESCE(EXCLUDED.key_label, agent_api_keys.key_label),
    updated_at = now();
END;
$$;

COMMENT ON FUNCTION brain_set_agent_api_key_secret(uuid, text, text, text)
IS 'Registers or rotates the verified secret for brain_<workspace>_<agent>_<secret> API keys.';

-- Seed quickstart localdev key so fresh installs verify out of the box.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM agents
     WHERE workspace_id = '00000000-0000-0000-0000-000000000001'
       AND agent_id = '00000000-0000-0000-0000-0000000000a1'
  ) THEN
    PERFORM brain_set_agent_api_key_secret(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-0000000000a1',
      'localdev',
      'quickstart-seed'
    );
  END IF;
END $$;
