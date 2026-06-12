-- Local (keyless) embeddings: Ollama nomic-embed-text, 768 dimensions.
--
-- Parallel to chunks_openai3small (1536d). The original embeddings migration
-- (20260415000016) anticipated exactly this: "Add future models by adding a
-- new table + index; no migration of existing data needed." The 1536/OpenAI
-- path is untouched — a workspace simply uses whichever provider is configured
-- (BRAIN_EMBED_PROVIDER), and search/context_pack join the matching table.
--
-- Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS chunks_ollama_nomic (
  chunk_id   uuid PRIMARY KEY REFERENCES chunks(chunk_id) ON DELETE CASCADE,
  embedding  vector(768) NOT NULL
);

CREATE INDEX IF NOT EXISTS chunks_ollama_nomic_embedding_idx
  ON chunks_ollama_nomic USING hnsw (embedding vector_cosine_ops);

-- Register the model (model_id PK, dimension, active). ON CONFLICT keeps reruns
-- safe and avoids clobbering a manually-toggled `active` flag.
INSERT INTO embedding_models (model_id, dimension, active)
VALUES ('ollama-nomic-embed-text', 768, true)
ON CONFLICT (model_id) DO NOTHING;
