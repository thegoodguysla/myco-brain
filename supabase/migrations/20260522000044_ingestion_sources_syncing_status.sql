-- Migration 044: allow transient syncing status for ingestion_sources lifecycle
ALTER TABLE ingestion_sources
  DROP CONSTRAINT IF EXISTS ingestion_sources_status_check;

ALTER TABLE ingestion_sources
  ADD CONSTRAINT ingestion_sources_status_check
  CHECK (status IN ('pending_setup','active','paused','error','disconnected','syncing'));
