-- Migration 041: Workspace-level auto-promotion threshold config
--
-- Stores the advisory confidence threshold in workspaces.settings so each
-- workspace can tune auto-promotion behavior independently.
-- Default is 0.60 for workspaces that do not yet define the key.

UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{auto_promote_min_confidence}',
  '0.60'::jsonb,
  true
)
WHERE NOT (COALESCE(settings, '{}'::jsonb) ? 'auto_promote_min_confidence');
