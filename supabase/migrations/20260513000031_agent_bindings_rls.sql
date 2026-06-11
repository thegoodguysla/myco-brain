-- Migration 031: THE-417 — RLS for agent_bindings table
--
-- Defense-in-depth: enables row-level security with workspace_isolation policy
-- on agent_bindings. Migration 029 created the table but missed RLS enablement.

ALTER TABLE agent_bindings ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON agent_bindings
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
