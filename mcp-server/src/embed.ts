/**
 * Server-side embedding via OpenAI text-embedding-3-small.
 * Only activates when BRAIN_OPENAI_API_KEY is set.
 * Returns undefined (caller falls back to BM25 only) if key is absent or call fails.
 */
import type pg from "pg";

const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";
const EMBED_MODEL = "text-embedding-3-small";

export async function embedQuery(
  text: string
): Promise<number[] | undefined> {
  const apiKey = process.env.BRAIN_OPENAI_API_KEY;
  if (!apiKey) return undefined;
  return callOpenAIEmbed(apiKey, text);
}

/**
 * Embed a batch of texts and write vectors to chunks_openai3small.
 * Called after chunk_ids are written to the chunks table.
 * No-op if BRAIN_OPENAI_API_KEY is not set.
 */
export async function embedAndStoreChunks(
  client: pg.PoolClient,
  chunks: Array<{ chunk_id: string; text: string }>
): Promise<void> {
  const apiKey = process.env.BRAIN_OPENAI_API_KEY;
  if (!apiKey || chunks.length === 0) return;

  // Batch embed in groups of 20 to stay well under OpenAI's 2048-input limit
  const BATCH_SIZE = 20;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(OPENAI_EMBED_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: EMBED_MODEL,
          input: batch.map((c) => c.text),
        }),
      });

      if (!res.ok) {
        const err = await res.text().catch(() => res.statusText);
        console.error(`[embed] OpenAI batch error ${res.status}: ${err}`);
        continue;
      }

      const json = (await res.json()) as {
        data: Array<{ index: number; embedding: number[] }>;
      };

      for (const item of json.data) {
        const chunk = batch[item.index];
        if (!chunk) continue;
        await client.query(
          `INSERT INTO chunks_openai3small (chunk_id, embedding)
           VALUES ($1, $2::vector)
           ON CONFLICT (chunk_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
          [chunk.chunk_id, `[${item.embedding.join(",")}]`]
        );
      }
    } catch (err) {
      console.error("[embed] batch embed failed:", err);
    }
  }
}

async function callOpenAIEmbed(
  apiKey: string,
  text: string
): Promise<number[] | undefined> {
  try {
    const res = await fetch(OPENAI_EMBED_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: text }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      console.error(`[embed] OpenAI error ${res.status}: ${err}`);
      return undefined;
    }

    const json = (await res.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    return json.data[0]?.embedding;
  } catch (err) {
    console.error("[embed] fetch failed:", err);
    return undefined;
  }
}
