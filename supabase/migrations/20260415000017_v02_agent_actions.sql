-- Migration 017: v0.2 A7 — Agent actions as first-class hyobjects

-- These are seeded as part of the type system seed, but the migration adds them
-- to the spec tables so future migrations can reference them.

-- AgentAction types are seeded in seed.sql:
--   type_id=80 'AgentAction'
--   subtype_ids 200-205 (EmailSent, DocumentDrafted, CodeCommitted, TaskCompleted, MessagePosted, APICallMade)

-- No DDL changes needed — agent actions are regular hyobjects with type_id=80.
-- The MCP server auto-inserts an AgentAction hyobject for every write call it handles.
-- This migration is a marker migration ensuring correct ordering.
SELECT 1;  -- no-op marker
