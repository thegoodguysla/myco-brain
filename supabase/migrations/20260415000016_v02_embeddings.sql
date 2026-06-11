-- Migration 016: v0.2 A10 — Pluggable embeddings

CREATE TABLE embedding_models (
  model_id   text PRIMARY KEY,   -- 'openai-3-small'|'voyage-2'|'local-nomic'
  dimension  int NOT NULL,
  active     boolean NOT NULL DEFAULT true
);

-- Per-model embedding tables (avoids dimension mismatches on model swaps)
CREATE TABLE chunks_openai3small (
  chunk_id   uuid PRIMARY KEY REFERENCES chunks(chunk_id) ON DELETE CASCADE,
  embedding  vector(1536) NOT NULL
);
CREATE INDEX ON chunks_openai3small USING hnsw (embedding vector_cosine_ops);

-- Add future models by adding a new table + index; no migration of existing data needed.

-- Seed known model
INSERT INTO embedding_models (model_id, dimension, active) VALUES
  ('openai-3-small', 1536, true);
