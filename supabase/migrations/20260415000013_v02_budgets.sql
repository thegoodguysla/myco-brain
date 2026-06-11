-- Migration 013: v0.2 A13 — Cost governor (workspace budgets + LLM spend events)

CREATE TABLE workspace_budgets (
  workspace_id       uuid PRIMARY KEY REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  monthly_cap_usd    numeric NOT NULL,
  current_spend_usd  numeric NOT NULL DEFAULT 0,
  hard_stop          boolean NOT NULL DEFAULT true,
  reset_at           timestamptz NOT NULL,
  tier_policy        jsonb NOT NULL DEFAULT
    '{"ner": "cheap", "description": "medium", "synthesis": "premium"}'
);

CREATE TABLE llm_spend_events (
  event_id      bigserial PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(workspace_id),
  model         text NOT NULL,
  tokens_in     int NOT NULL,
  tokens_out    int NOT NULL,
  usd           numeric NOT NULL,
  purpose       text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON llm_spend_events (workspace_id, created_at DESC);

-- Auto-accumulate spend into workspace_budgets
CREATE OR REPLACE FUNCTION accumulate_llm_spend()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE workspace_budgets
  SET current_spend_usd = current_spend_usd + NEW.usd
  WHERE workspace_id = NEW.workspace_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER accumulate_llm_spend_trigger
  AFTER INSERT ON llm_spend_events
  FOR EACH ROW EXECUTE FUNCTION accumulate_llm_spend();
