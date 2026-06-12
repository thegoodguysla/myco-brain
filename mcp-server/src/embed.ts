/**
 * Server-side embedding with a pluggable provider.
 *
 * Providers:
 *   - openai  text-embedding-3-small (1536d) → chunks_openai3small.
 *             Needs BRAIN_OPENAI_API_KEY.
 *   - ollama  nomic-embed-text (768d) → chunks_ollama_nomic. Fully keyless;
 *             talks to a local Ollama (BRAIN_OLLAMA_BASE_URL, default
 *             http://localhost:11434). This is what lets semantic search run
 *             with no API key at all.
 *
 * Selection (getEmbeddingProvider):
 *   - BRAIN_EMBED_PROVIDER="openai"|"ollama" forces a provider, else auto:
 *     OpenAI when a key is present, otherwise Ollama when a base URL is
 *     configured, otherwise none.
 *   - When no provider resolves, embedQuery returns undefined and callers fall
 *     back to BM25-only full-text search (vector_used: false).
 */
import type pg from "pg";

const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";
const OPENAI_MODEL = "text-embedding-3-small";
const OPENAI_DIM = 1536;
const OPENAI_TABLE = "chunks_openai3small";

const OLLAMA_DIM = 768;
const OLLAMA_TABLE = "chunks_ollama_nomic";
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

export type EmbeddingProviderName = "openai" | "ollama";

export interface EmbeddingProvider {
  name: EmbeddingProviderName;
  /** Vector dimension this provider emits. */
  dimension: number;
  /** Per-model embeddings table that search/context_pack must join. */
  table: string;
  /**
   * Embed a batch of texts. Returns one vector per input (in order); an entry
   * is `undefined` if that text failed to embed (caller skips it).
   */
  embed(texts: string[]): Promise<(number[] | undefined)[]>;
}

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

export function getEmbeddingProvider(): EmbeddingProvider | null {
  const explicit = (process.env.BRAIN_EMBED_PROVIDER ?? "").trim().toLowerCase();
  const openaiKey = process.env.BRAIN_OPENAI_API_KEY;
  const ollamaBase = (process.env.BRAIN_OLLAMA_BASE_URL ?? "").replace(/\/$/, "");

  if (explicit === "ollama") {
    return makeOllamaProvider(ollamaBase || DEFAULT_OLLAMA_BASE_URL);
  }
  if (explicit === "openai") {
    return openaiKey ? makeOpenAIProvider(openaiKey) : null;
  }

  // Auto: prefer OpenAI when keyed, else keyless Ollama when configured.
  if (openaiKey) return makeOpenAIProvider(openaiKey);
  if (ollamaBase) return makeOllamaProvider(ollamaBase);
  return null;
}

/** Embeddings table for the active provider (default openai's when none). */
export function activeEmbeddingTable(): string {
  return getEmbeddingProvider()?.table ?? OPENAI_TABLE;
}

/** Vector dimension for the active provider, or null when none resolves. */
export function activeEmbeddingDimension(): number | null {
  return getEmbeddingProvider()?.dimension ?? null;
}

// ---------------------------------------------------------------------------
// Public API (unchanged signatures; now provider-aware)
// ---------------------------------------------------------------------------

export async function embedQuery(text: string): Promise<number[] | undefined> {
  const provider = getEmbeddingProvider();
  if (!provider) return undefined;
  const [vec] = await provider.embed([text]);
  return vec;
}

/**
 * Embed a batch of texts and write vectors to the active provider's table.
 * Called after chunk_ids are written to the chunks table. No-op if no provider.
 */
export async function embedAndStoreChunks(
  client: pg.PoolClient,
  chunks: Array<{ chunk_id: string; text: string }>
): Promise<void> {
  const provider = getEmbeddingProvider();
  if (!provider || chunks.length === 0) return;

  // The table name is from a fixed allowlist (provider.table), never user input.
  const table = provider.table;
  const BATCH_SIZE = 20;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    try {
      const vectors = await provider.embed(batch.map((c) => c.text));
      for (let j = 0; j < batch.length; j++) {
        const embedding = vectors[j];
        if (!embedding) continue;
        await client.query(
          `INSERT INTO ${table} (chunk_id, embedding)
           VALUES ($1, $2::vector)
           ON CONFLICT (chunk_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
          [batch[j].chunk_id, `[${embedding.join(",")}]`]
        );
      }
    } catch (err) {
      console.error(`[embed] batch embed failed (${provider.name}):`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI provider
// ---------------------------------------------------------------------------

function makeOpenAIProvider(apiKey: string): EmbeddingProvider {
  return {
    name: "openai",
    dimension: OPENAI_DIM,
    table: OPENAI_TABLE,
    async embed(texts: string[]): Promise<(number[] | undefined)[]> {
      if (texts.length === 0) return [];
      try {
        const res = await fetch(OPENAI_EMBED_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model: OPENAI_MODEL, input: texts }),
        });
        if (!res.ok) {
          const err = await res.text().catch(() => res.statusText);
          console.error(`[embed] OpenAI error ${res.status}: ${err}`);
          return texts.map(() => undefined);
        }
        const json = (await res.json()) as {
          data: Array<{ index: number; embedding: number[] }>;
        };
        const out: (number[] | undefined)[] = texts.map(() => undefined);
        for (const item of json.data) out[item.index] = item.embedding;
        return out;
      } catch (err) {
        console.error("[embed] OpenAI fetch failed:", err);
        return texts.map(() => undefined);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Ollama provider (keyless, local)
// ---------------------------------------------------------------------------

function makeOllamaProvider(baseUrl: string): EmbeddingProvider {
  const model = process.env.BRAIN_OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
  const url = `${baseUrl}/api/embeddings`;
  return {
    name: "ollama",
    dimension: OLLAMA_DIM,
    table: OLLAMA_TABLE,
    async embed(texts: string[]): Promise<(number[] | undefined)[]> {
      if (texts.length === 0) return [];
      // /api/embeddings is single-prompt; embed the batch concurrently.
      return Promise.all(
        texts.map(async (text) => {
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model, prompt: text }),
            });
            if (!res.ok) {
              const err = await res.text().catch(() => res.statusText);
              console.error(`[embed] Ollama error ${res.status}: ${err}`);
              return undefined;
            }
            const json = (await res.json()) as { embedding?: number[] };
            return json.embedding && json.embedding.length > 0
              ? json.embedding
              : undefined;
          } catch (err) {
            console.error("[embed] Ollama fetch failed:", err);
            return undefined;
          }
        })
      );
    },
  };
}
