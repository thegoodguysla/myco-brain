/**
 * brain_ingest — file/URL/text ingestion via MCP.
 *
 * text mode: chunks and indexes inline — fully searchable immediately.
 * url/file modes: creates the record and enqueues for the ingestion worker.
 *
 * Supports three ingest modes:
 *   1. text   — raw text content provided inline (processed immediately)
 *   2. url    — HTTP/HTTPS URL (worker fetches it)
 *   3. file   — base64-encoded file content (worker parses it)
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import type pg from "pg";
import { withSession, getPool, type SessionContext } from "../db.js";
import { sanitize } from "../sanitize.js";
import { embedAndStoreChunks, getEmbeddingProvider } from "../embed.js";
import { resolveExtraction } from "../doctor-live.js";

// Best-effort background embedding tasks started by ingest() (text mode). The
// long-running MCP server lets these settle on their own; short-lived callers
// such as the bulk-import CLI must call flushPendingEmbeddings() before closing
// the pool / exiting, or the process tears down mid-embed and vector search
// never gets populated for what was just imported.
const pendingEmbeddings = new Set<Promise<void>>();

/** Await all in-flight background embedding tasks. Safe to call any time. */
export async function flushPendingEmbeddings(): Promise<void> {
  await Promise.allSettled([...pendingEmbeddings]);
}

export const IngestInput = z.object({
  mode: z.enum(["text", "url", "file"]),
  // text mode
  text: z.string().optional().describe("Raw text content (mode=text)"),
  // url mode
  url: z.string().url().optional().describe("URL to ingest (mode=url)"),
  // file mode
  file_content_base64: z
    .string()
    .optional()
    .describe("Base64-encoded file bytes (mode=file)"),
  file_name: z.string().optional().describe("Original filename (mode=file)"),
  mime_type: z.string().optional(),
  // common metadata
  name: z.string().optional().describe("Human-readable name for this object"),
  type_id: z
    .number()
    .int()
    .default(1)
    .describe("hyobject_types.type_id — defaults to 1 (Document)"),
  subtype_id: z
    .number()
    .int()
    .optional()
    .describe("hyobject_subtypes.subtype_id — defaults to 1 (Generic). Overridden by source category rule if source_id is provided."),
  sharing_type_id: z
    .number()
    .int()
    .optional()
    .describe("sharing_types.sharing_type_id — defaults to 2 (workspace). Overridden by source privacy_default if source_id is provided."),
  source_id: z
    .string()
    .uuid()
    .optional()
    .describe("ingestion_sources.source_id — when set, applies category_tag prior and privacy_default from the source profile."),
  tags: z.record(z.string()).optional().describe("Additional metadata as key/value"),
});

export type IngestInput = z.infer<typeof IngestInput>;

export interface IngestResult {
  hyobject_id: string;
  processing_state: string;
  name: string | null;
  storage_uri: string | null;
  deduped?: boolean;
  // Honest receipt: did this ingest feed the knowledge graph, or is it
  // searchable-only because no extractor is configured? Lets the agent know
  // whether the program actually built facts from the source.
  extraction?: "graph" | "search-only";
  message: string;
}

export async function ingest(
  ctx: SessionContext,
  input: IngestInput
): Promise<IngestResult> {
  return withSession(
    { ...ctx, actorKind: "agent", reason: "ingest" },
    async (client) => {
      let storageUri: string | null = null;
      let mimeType: string | null = input.mime_type ?? null;

      if (input.mode === "url") {
        if (!input.url) throw new Error("url is required for mode=url");
        storageUri = input.url;
        mimeType = mimeType ?? "text/html";
      } else if (input.mode === "file") {
        if (!input.file_content_base64) {
          throw new Error("file_content_base64 is required for mode=file");
        }
        // Store raw base64 in storage_uri as a data URI marker.
        // The ingestion worker replaces this with the actual object storage URI.
        storageUri = `data:pending/${input.file_name ?? "upload"}`;
        mimeType = mimeType ?? guessMimeType(input.file_name ?? "");
      } else {
        // text mode — no storage URI, content will be passed via metadata
        mimeType = mimeType ?? "text/plain";
      }

      const name = input.name ?? (input.mode === "url" ? input.url : input.file_name) ?? null;

      const metadata: Record<string, unknown> = { ...(input.tags ?? {}) };
      if (input.mode === "text" && input.text) {
        metadata["inline_text"] = sanitize(input.text);
      }
      if (input.mode === "file" && input.file_content_base64) {
        metadata["file_base64"] = input.file_content_base64;
        metadata["file_name"] = input.file_name ?? null;
      }

      // --- Source profile: category_tag prior and privacy_default ---
      let subtypeId = input.subtype_id ?? 1;
      let sharingTypeId = input.sharing_type_id ?? 2;

      if (input.source_id) {
        const sourceRes = await client.query(
          `SELECT source_id, category_tag, privacy_default
             FROM ingestion_sources
            WHERE source_id = $1 AND workspace_id = $2 AND status = 'active'`,
          [input.source_id, ctx.workspaceId]
        );

        if (sourceRes.rows.length > 0) {
          const source = sourceRes.rows[0];

          // Apply source privacy_default → sharing_type_id (caller override respected if explicit)
          if (input.sharing_type_id === undefined) {
            const stRes = await client.query(
              `SELECT sharing_type_id FROM sharing_types WHERE name = $1`,
              [source.privacy_default]
            );
            if (stRes.rows.length > 0) {
              sharingTypeId = stRes.rows[0].sharing_type_id;
            }
          }

          // Find best-matching category rule (priority ASC, first match wins)
          const rulesRes = await client.query(
            `SELECT category_tag, subtype_hint, entity_hints, match_pattern
               FROM source_category_rules
              WHERE source_id = $1
              ORDER BY priority ASC`,
            [input.source_id]
          );

          let matchedTag: string | null = null;
          let matchedSubtype: number | null = null;
          let matchedEntityHints: unknown[] = [];

          for (const rule of rulesRes.rows) {
            if (matchesPattern(rule.match_pattern, { name, mimeType })) {
              matchedTag = rule.category_tag;
              matchedSubtype = rule.subtype_hint ?? null;
              matchedEntityHints = rule.entity_hints ?? [];
              break;
            }
          }

          // Fall back to source-level category_tag if no rule matched
          const categoryTag = matchedTag ?? source.category_tag ?? null;

          if (categoryTag) {
            metadata["category_tag"] = categoryTag;
          }
          if (matchedEntityHints.length > 0) {
            metadata["entity_hints"] = matchedEntityHints;
          }
          if (matchedSubtype !== null && input.subtype_id === undefined) {
            subtypeId = matchedSubtype;
          }

          metadata["source_id"] = input.source_id;
        }
      }

      // For text mode: process inline — chunk, write to FTS, enqueue for extraction.
      // For url/file modes: record is created with pending_deterministic for the worker.
      const isTextMode = input.mode === "text" && !!input.text;
      const processingState = isTextMode ? "done" : "pending_deterministic";
      const textContent = isTextMode ? sanitize(input.text!) : null;

      // Content hash for deduplication. hyobjects has UNIQUE (workspace_id,
      // sha256), so re-ingesting identical content is a no-op instead of a
      // duplicate — this is the guarantee that lets `mycobrain-ingest` re-run on
      // a folder, or an agent re-save a fact, without growing duplicate memory.
      // We hash the canonical content that defines the object per mode.
      const hashInput =
        input.mode === "text"
          ? textContent ?? ""
          : input.mode === "url"
            ? input.url ?? ""
            : input.file_content_base64 ?? "";
      const sha256 = createHash("sha256").update(hashInput).digest("hex");

      const res = await client.query(
        `INSERT INTO hyobjects
           (workspace_id, type_id, subtype_id, name, storage_uri, mime_type,
            sharing_type_id, processing_state, sha256, content_tsv, agent_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 CASE WHEN $10::text IS NOT NULL THEN to_tsvector('english', $10::text) ELSE NULL END,
                 $11)
         ON CONFLICT (workspace_id, sha256) DO NOTHING
         RETURNING hyobject_id, processing_state, name, storage_uri`,
        [
          ctx.workspaceId,
          input.type_id,
          subtypeId,
          name,
          storageUri,
          mimeType,
          sharingTypeId,
          processingState,
          sha256,
          textContent,
          // Creator attribution — private (sharing_type 1) documents are only
          // visible to the agent that created them.
          ctx.actorId,
        ]
      );

      // On conflict the INSERT returns no row: identical content already exists.
      // Return the existing object and skip re-chunking/re-embedding.
      const deduped = res.rows.length === 0;
      let row = res.rows[0];
      if (deduped) {
        const existing = await client.query(
          `SELECT hyobject_id, processing_state, name, storage_uri
             FROM hyobjects
            WHERE workspace_id = $1 AND sha256 = $2`,
          [ctx.workspaceId, sha256]
        );
        row = existing.rows[0];
      }
      const hyobjectId: string = row.hyobject_id;

      // Write chunks for text mode — enables BM25 + vector search immediately
      let chunkCount = 0;
      const chunksForEmbedding: Array<{ chunk_id: string; text: string }> = [];

      if (!deduped && isTextMode && textContent) {
        const textChunks = splitIntoChunks(textContent);
        for (let i = 0; i < textChunks.length; i++) {
          const chunkText = textChunks[i];
          const chunkRes = await client.query(
            `INSERT INTO chunks (hyobject_id, workspace_id, chunk_index, text, metadata)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING chunk_id`,
            [hyobjectId, ctx.workspaceId, i, chunkText, JSON.stringify(metadata)]
          );
          const chunkId = chunkRes.rows[0].chunk_id;
          chunksForEmbedding.push({ chunk_id: chunkId, text: chunkText });
          chunkCount++;

          // Enqueue for entity extraction worker
          await client.query(
            `INSERT INTO chunk_extraction_status (chunk_id, workspace_id, status)
             VALUES ($1, $2, 'pending')
             ON CONFLICT (chunk_id) DO NOTHING`,
            [chunkId, ctx.workspaceId]
          );
        }
      }

      // Also insert an AgentAction hyobject (type_id=80) per migration 017.
      // Skip on dedup so a re-ingest doesn't accrue phantom action records.
      if (!deduped) {
        await client.query(
          `INSERT INTO hyobjects
             (workspace_id, type_id, subtype_id, name, sharing_type_id, processing_state, agent_id)
           VALUES ($1, 80, 200, $2, $3, 'done', $4)`,
          [
            ctx.workspaceId,
            `Ingested: ${name ?? "unnamed"}`,
            sharingTypeId,
            ctx.actorId,
          ]
        );
      }

      // Embed chunks after the transaction — best-effort, non-blocking.
      // Uses a fresh pool client so the embedding writes don't share the
      // transaction connection (which is released on withSession exit). The
      // task is tracked in `pendingEmbeddings` so short-lived callers (the
      // bulk-import CLI) can await it before closing the pool / exiting —
      // otherwise the process dies mid-embed and vector search stays empty.
      if (chunksForEmbedding.length > 0) {
        const embeddingChunks = chunksForEmbedding.slice();
        const task = (async () => {
          const embedClient = await getPool().connect();
          try {
            await embedAndStoreChunks(embedClient, embeddingChunks);
          } catch (err) {
            console.error("[ingest] embedding failed (non-fatal):", err);
          } finally {
            embedClient.release();
          }
        })();
        pendingEmbeddings.add(task);
        void task.finally(() => pendingEmbeddings.delete(task));
      }

      const graphBuilt = resolveExtraction().provider !== "none";
      const extractionNote = deduped
        ? ""
        : graphBuilt
          ? " Queued for knowledge-graph extraction — the program will pull entities and relations with provenance and confidence."
          : " No knowledge-graph extractor is configured, so this is searchable but builds no fact graph. Enable a local Ollama extractor (run `mycobrain-doctor`) to extract facts.";

      const modeNote = deduped
        ? "Already ingested — identical content matched an existing object by content hash (deduplicated, no duplicate created)."
        : isTextMode
          ? `Text indexed inline: ${chunkCount} chunk(s) written, BM25 searchable immediately.${
              getEmbeddingProvider()
                ? ` Vector embeddings (${getEmbeddingProvider()?.name}) computing in the background.`
                : " No embedding provider configured — set BRAIN_EMBED_PROVIDER=ollama (keyless) or BRAIN_OPENAI_API_KEY for semantic search."
            }`
          : "Hyobject created with processing_state=pending_deterministic. The ingestion worker will parse, chunk, and embed the content.";

      return {
        hyobject_id: hyobjectId,
        processing_state: row.processing_state,
        name: row.name,
        storage_uri: row.storage_uri,
        // Additive: true when content-hash dedup matched an existing document
        // (callers like the bulk-import CLI report ingested vs skipped).
        deduped,
        extraction: graphBuilt ? "graph" : "search-only",
        message: deduped
          ? "Identical content already exists — returned the existing document (content-hash dedup)."
          : modeNote + extractionNote,
      };
    }
  );
}

/**
 * Split text into overlapping chunks of ~1000 chars.
 * Breaks on paragraph boundaries when possible.
 */
function splitIntoChunks(text: string, maxChars = 1000, overlap = 150): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      // Keep overlap: last N chars of the current chunk
      current = current.slice(-overlap) + "\n\n" + para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }

  if (current.trim().length > 0) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
}

/**
 * Checks whether a source_category_rules match_pattern applies to this object.
 * Supported pattern keys:
 *   mime_type        — exact match against resolved mime type
 *   name_contains    — case-insensitive substring match against object name
 * An empty pattern {} matches everything.
 */
function matchesPattern(
  pattern: Record<string, unknown>,
  obj: { name: string | null; mimeType: string | null }
): boolean {
  if (pattern["mime_type"] !== undefined) {
    if (pattern["mime_type"] !== obj.mimeType) return false;
  }
  if (pattern["name_contains"] !== undefined) {
    const needle = String(pattern["name_contains"]).toLowerCase();
    if (!obj.name?.toLowerCase().includes(needle)) return false;
  }
  return true;
}

function guessMimeType(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    md: "text/markdown",
    eml: "message/rfc822",
    html: "text/html",
    csv: "text/csv",
  };
  return map[ext] ?? "application/octet-stream";
}
