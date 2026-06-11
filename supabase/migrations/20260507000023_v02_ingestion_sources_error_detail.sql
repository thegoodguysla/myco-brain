-- Migration 023: Add error_detail column to ingestion_sources for worker diagnostics
ALTER TABLE ingestion_sources ADD COLUMN IF NOT EXISTS error_detail text;
ALTER TABLE ingestion_sources ADD COLUMN IF NOT EXISTS error_at timestamptz;
