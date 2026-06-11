import "dotenv/config";

import type pg from "pg";
import Anthropic from "@anthropic-ai/sdk";
import { closePool, withSession } from "./db.js";
import { resolveAuth } from "./auth.js";
import {
  clampConfidence,
  fakeExtractEntities,
  safeParse,
  type ExtractionOutput,
} from "./extraction-worker.lib.js";

type ExtractionStatus = "pending" | "processing" | "succeeded" | "failed";

interface ClaimedChunk {
  chunkId: string;
  hyobjectId: string;
  workspaceId: string;
  text: string;
}

const POLL_INTERVAL_MS = Number(process.env.BRAIN_EXTRACTION_POLL_MS ?? 5000);
const BATCH_SIZE = Number(process.env.BRAIN_EXTRACTION_BATCH_SIZE ?? 10);
const MAX_ATTEMPTS = Number(process.env.BRAIN_EXTRACTION_MAX_ATTEMPTS ?? 3);
const MAX_TEXT_CHARS = Number(process.env.BRAIN_EXTRACTION_MAX_TEXT_CHARS ?? 8000);
const MODEL = process.env.BRAIN_EXTRACTION_MODEL ?? "claude-sonnet-4-20250514";

// Ollama lets the knowledge graph run fully locally — no API keys. Set
// BRAIN_OLLAMA_BASE_URL (e.g. http://localhost:11434) and pull a chat model.
const OLLAMA_BASE_URL = (process.env.BRAIN_OLLAMA_BASE_URL ?? "").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.BRAIN_OLLAMA_MODEL ?? "llama3.2:3b";

const anthropicApiKey = process.env.BRAIN_ANTHROPIC_API_KEY;

const auth = resolveAuth({
  apiKey: process.env.BRAIN_API_KEY,
  workspaceId: process.env.BRAIN_WORKSPACE_ID,
  agentId: process.env.BRAIN_AGENT_ID,
});

const anthropic = anthropicApiKey ? new Anthropic({ apiKey: anthropicApiKey }) : null;

// Provider precedence: explicit override → fake (tests) → Anthropic (if key) →
// Ollama (if configured) → fake fallback. This is what makes the graph keyless:
// with no Anthropic key but a local Ollama, extraction still runs for real.
const EXTRACTION_PROVIDER: "anthropic" | "ollama" | "fake" =
  (process.env.BRAIN_EXTRACTION_PROVIDER as "anthropic" | "ollama" | "fake" | undefined) ??
  (process.env.BRAIN_EXTRACTION_FAKE === "1"
    ? "fake"
    : anthropic
      ? "anthropic"
      : OLLAMA_BASE_URL
        ? "ollama"
        : "fake");

// Recorded in proposed_entities.extracted_by for provenance.
const EXTRACTOR_LABEL =
  EXTRACTION_PROVIDER === "ollama"
    ? `ollama:${OLLAMA_MODEL}`
    : EXTRACTION_PROVIDER === "anthropic"
      ? `llm:${MODEL}`
      : "program:fake-extractor";

const EXTRACTION_SYSTEM =
  'Extract named entities AND the relationships between them from text. Return only JSON with shape ' +
  '{"entities":[{"name":string,"kind":string,"aliases":string[],"confidence":number}],' +
  '"relations":[{"subject":string,"predicate":string,"object":string,"confidence":number}]}. ' +
  '"kind" is one of: organization, person, project, location. ' +
  'In relations, "subject" and "object" MUST be names that appear in entities, and "predicate" is a short verb phrase such as "owns", "works for", "manages", "launches", "located in". ' +
  'Only include a relation if the text clearly states it. "confidence" is 0-1; use >=0.7 when sure. No extra keys, no prose.';


async function claimBatch(): Promise<ClaimedChunk[]> {
  return withSession(auth.ctx, async (client) => {
    const claimed = await client.query<ClaimedChunk>(
      `WITH candidate AS (
         SELECT ces.chunk_id, c.hyobject_id, c.workspace_id, c.text
         FROM chunk_extraction_status ces
         JOIN chunks c ON c.chunk_id = ces.chunk_id
         WHERE ces.workspace_id = $1
           AND ces.status IN ('pending','failed')
           AND ces.attempts < $2
         ORDER BY ces.updated_at ASC
         LIMIT $3
         FOR UPDATE OF ces SKIP LOCKED
       )
       UPDATE chunk_extraction_status ces
       SET status = 'processing',
           attempts = attempts + 1,
           last_error = NULL,
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('claimed_at', now())
       FROM candidate
       WHERE ces.chunk_id = candidate.chunk_id
       RETURNING candidate.chunk_id AS "chunkId",
                 candidate.hyobject_id AS "hyobjectId",
                 candidate.workspace_id AS "workspaceId",
                 candidate.text AS text`,
      [auth.ctx.workspaceId, MAX_ATTEMPTS, BATCH_SIZE],
    );
    return claimed.rows;
  });
}

async function mapEntityKindIds(): Promise<Map<string, number>> {
  return withSession(auth.ctx, async (client) => {
    const res = await client.query<{ kind_id: number; name: string }>(
      `SELECT kind_id, name FROM entity_kinds`,
    );
    const m = new Map<string, number>();
    for (const row of res.rows) {
      m.set(row.name.toLowerCase(), row.kind_id);
    }
    return m;
  });
}

async function extractEntities(text: string): Promise<ExtractionOutput> {
  const input = text.slice(0, MAX_TEXT_CHARS);
  if (EXTRACTION_PROVIDER === "ollama") return extractWithOllama(input);
  if (EXTRACTION_PROVIDER === "anthropic" && anthropic) {
    return extractWithAnthropic(anthropic, input);
  }
  return fakeExtractEntities(text);
}

async function extractWithAnthropic(
  client: Anthropic,
  input: string
): Promise<ExtractionOutput> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    temperature: 0,
    system: EXTRACTION_SYSTEM,
    messages: [{ role: "user", content: `Text:\n\n${input}` }],
  });
  const textBlock = response.content.find((p) => p.type === "text");
  if (!textBlock || textBlock.type !== "text") return { entities: [], relations: [] };
  return safeParse(textBlock.text);
}

async function extractWithOllama(input: string): Promise<ExtractionOutput> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      format: "json", // forces valid JSON output
      options: { temperature: 0 },
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM },
        { role: "user", content: `Text:\n\n${input}` },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Ollama extraction error ${res.status}: ${err}`);
  }
  const json = (await res.json()) as { message?: { content?: string } };
  return safeParse(json.message?.content ?? "");
}

async function markFailed(chunkId: string, error: string): Promise<void> {
  const nextStatus: ExtractionStatus = error.includes("attempt") ? "failed" : "pending";
  await withSession(auth.ctx, async (client) => {
    await client.query(
      `UPDATE chunk_extraction_status
       SET status = $2,
           last_error = left($3, 2000),
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('last_failed_at', now())
       WHERE chunk_id = $1`,
      [chunkId, nextStatus, error],
    );
  });
}

// Auto-promote threshold from workspace settings (default 0.6). Cached per run.
let _autoPromoteThreshold: number | null = null;
async function getAutoPromoteThreshold(): Promise<number> {
  if (_autoPromoteThreshold !== null) return _autoPromoteThreshold;
  _autoPromoteThreshold = await withSession(auth.ctx, async (client) => {
    const r = await client.query<{ t: string | null }>(
      `SELECT settings->>'auto_promote_min_confidence' AS t
         FROM workspaces WHERE workspace_id = $1`,
      [auth.ctx.workspaceId],
    );
    const raw = r.rows[0]?.t;
    const n = raw != null ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.6;
  });
  return _autoPromoteThreshold;
}

// Append aliases to an entity, de-duplicated.
async function addAliases(
  client: pg.PoolClient,
  entityId: string,
  aliases: string[],
): Promise<void> {
  if (aliases.length === 0) return;
  await client.query(
    `UPDATE entities
        SET aliases = ARRAY(
              SELECT DISTINCT x FROM unnest(aliases || $2::text[]) x
               WHERE x <> canonical_name
            )
      WHERE entity_id = $1`,
    [entityId, aliases],
  );
}

// Resolve an extracted entity to a canonical entity_id, with light entity
// resolution so "Priya" and "Priya Raman" (or "Northwind" / "Northwind Coffee")
// collapse into one node instead of cluttering the graph with near-duplicates.
async function resolveOrCreateEntity(
  client: pg.PoolClient,
  workspaceId: string,
  kindId: number,
  name: string,
  aliases: string[],
): Promise<string> {
  // 1) Exact (case-insensitive) match.
  const exact = await client.query<{ entity_id: string }>(
    `SELECT entity_id FROM entities
      WHERE workspace_id = $1 AND lower(canonical_name) = lower($2) LIMIT 1`,
    [workspaceId, name],
  );
  if (exact.rows[0]) {
    await addAliases(client, exact.rows[0].entity_id, aliases);
    return exact.rows[0].entity_id;
  }

  // 2) Token-overlap match within the same kind: one name is a leading/trailing
  //    token-subset of the other. Prefer the most specific (longest) match.
  const related = await client.query<{ entity_id: string; canonical_name: string }>(
    `SELECT entity_id, canonical_name FROM entities
      WHERE workspace_id = $1 AND kind_id = $2
        AND (
          lower(canonical_name) LIKE lower($3) || ' %' OR
          lower(canonical_name) LIKE '% ' || lower($3) OR
          lower($3) LIKE lower(canonical_name) || ' %' OR
          lower($3) LIKE '% ' || lower(canonical_name)
        )
      ORDER BY length(canonical_name) DESC
      LIMIT 1`,
    [workspaceId, kindId, name],
  );
  const match = related.rows[0];
  if (match) {
    if (name.length > match.canonical_name.length) {
      // The new name is more specific — make it canonical, fold the old in.
      await client.query(
        `UPDATE entities
            SET canonical_name = $2,
                aliases = ARRAY(
                  SELECT DISTINCT x
                    FROM unnest(aliases || $3::text[] || ARRAY[$4]::text[]) x
                   WHERE x <> $2
                )
          WHERE entity_id = $1`,
        [match.entity_id, name, aliases, match.canonical_name],
      );
    } else {
      await addAliases(client, match.entity_id, [...aliases, name]);
    }
    return match.entity_id;
  }

  // 3) New entity.
  const created = await client.query<{ entity_id: string }>(
    `INSERT INTO entities (workspace_id, kind_id, canonical_name, aliases)
     VALUES ($1, $2, $3, $4) RETURNING entity_id`,
    [workspaceId, kindId, name, aliases],
  );
  return created.rows[0].entity_id;
}

// Resolve a relation endpoint name to an already-promoted entity. Never creates
// entities — a relation to something we didn't extract as an entity is dropped,
// which keeps hallucinated edges out of the graph.
async function resolveRelationEndpoint(
  client: pg.PoolClient,
  workspaceId: string,
  nameMap: Map<string, string>,
  name: string,
): Promise<string | null> {
  const fromChunk = nameMap.get(name.toLowerCase());
  if (fromChunk) return fromChunk;
  const r = await client.query<{ entity_id: string }>(
    `SELECT entity_id FROM entities
      WHERE workspace_id = $1 AND lower(canonical_name) = lower($2) LIMIT 1`,
    [workspaceId, name],
  );
  return r.rows[0]?.entity_id ?? null;
}

async function persistSuccess(
  chunk: ClaimedChunk,
  output: ExtractionOutput,
  kindMap: Map<string, number>,
): Promise<void> {
  const threshold = await getAutoPromoteThreshold();
  await withSession(auth.ctx, async (client) => {
    let promoted = 0;
    // Names (and aliases) promoted in this chunk → entity_id, for resolving the
    // endpoints of relations extracted from the same chunk.
    const nameToEntityId = new Map<string, string>();

    for (const entity of output.entities) {
      const kindId =
        kindMap.get(entity.kind?.toLowerCase?.() ?? "") ??
        kindMap.get("organization") ??
        1;
      const confidence = clampConfidence(entity.confidence);
      const aliases = entity.aliases ?? [];

      const proposal = await client.query<{ id: string }>(
        `INSERT INTO proposed_entities
           (workspace_id, kind_id, canonical_name, aliases, source_hyobject_id, extracted_by, confidence, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         RETURNING id`,
        [chunk.workspaceId, kindId, entity.name, aliases, chunk.hyobjectId, EXTRACTOR_LABEL, confidence],
      );
      const proposedId = proposal.rows[0].id;

      // Promote confident entities into the canonical graph so they're queryable
      // via brain_neighbors / get_related, and link them to their source doc.
      if (confidence >= threshold) {
        const entityId = await resolveOrCreateEntity(
          client,
          chunk.workspaceId,
          kindId,
          entity.name,
          aliases,
        );

        await client.query(
          `UPDATE proposed_entities
             SET state = 'auto_promoted', promoted_entity_id = $2, reviewed_at = now()
           WHERE id = $1`,
          [proposedId, entityId],
        );

        // entity_mentions is the entity↔document edge the graph tools traverse.
        await client.query(
          `INSERT INTO entity_mentions
             (workspace_id, entity_id, hyobject_id, chunk_id, confidence)
           VALUES ($1, $2, $3, $4, $5)`,
          [chunk.workspaceId, entityId, chunk.hyobjectId, chunk.chunkId, confidence],
        );

        nameToEntityId.set(entity.name.toLowerCase(), entityId);
        for (const a of aliases) nameToEntityId.set(a.toLowerCase(), entityId);
        promoted++;
      }
    }

    // Relations: connect promoted entities to each other (the entity↔entity
    // graph edges that turn this from a vector store into a knowledge graph).
    let relationsAdded = 0;
    for (const rel of output.relations ?? []) {
      const relConfidence = clampConfidence(rel.confidence);
      if (relConfidence < threshold) continue;
      const subjectId = await resolveRelationEndpoint(client, chunk.workspaceId, nameToEntityId, rel.subject);
      const objectId = await resolveRelationEndpoint(client, chunk.workspaceId, nameToEntityId, rel.object);
      if (!subjectId || !objectId || subjectId === objectId) continue;

      await client.query(
        `INSERT INTO proposed_relations
           (workspace_id, subject_kind, subject_id, object_kind, object_id, predicate,
            source_hyobject_id, extracted_by, confidence, state)
         VALUES ($1, 'entity', $2, 'entity', $3, $4, $5, $6, $7, 'auto_promoted')`,
        [chunk.workspaceId, subjectId, objectId, rel.predicate, chunk.hyobjectId, EXTRACTOR_LABEL, relConfidence],
      );

      // entity_relations is the promoted graph edge. De-dupe identical edges
      // (same pair + predicate) that may recur across chunks.
      const ins = await client.query(
        `INSERT INTO entity_relations
           (workspace_id, entity1_id, entity2_id, predicate, source_hyobject_id, confidence)
         SELECT $1, $2, $3, $4, $5, $6
         WHERE NOT EXISTS (
           SELECT 1 FROM entity_relations
            WHERE workspace_id = $1 AND entity1_id = $2 AND entity2_id = $3 AND predicate = $4
         )`,
        [chunk.workspaceId, subjectId, objectId, rel.predicate, chunk.hyobjectId, relConfidence],
      );
      if (ins.rowCount && ins.rowCount > 0) relationsAdded++;
    }

    await client.query(
      `UPDATE chunk_extraction_status
       SET status = 'succeeded',
           extracted_at = now(),
           last_error = NULL,
           metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('entity_count', $2::int, 'promoted_count', $3::int, 'relation_count', $4::int)
       WHERE chunk_id = $1`,
      [chunk.chunkId, output.entities.length, promoted, relationsAdded],
    );
  });
}

async function processOne(chunk: ClaimedChunk, kindMap: Map<string, number>): Promise<void> {
  try {
    const output = await extractEntities(chunk.text);
    await persistSuccess(chunk, output, kindMap);
    console.log(
      JSON.stringify({
        chunk_id: chunk.chunkId,
        status: "succeeded",
        entities: output.entities.length,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFailed(chunk.chunkId, message);
    console.error(
      JSON.stringify({
        chunk_id: chunk.chunkId,
        status: "failed",
        error: message,
      }),
    );
  }
}

async function runOnce(kindMap: Map<string, number>): Promise<number> {
  const batch = await claimBatch();
  if (batch.length === 0) return 0;

  for (const chunk of batch) {
    await processOne(chunk, kindMap);
  }

  return batch.length;
}

async function main(): Promise<void> {
  const kindMap = await mapEntityKindIds();
  const once = process.argv.includes("--once");

  if (once) {
    await runOnce(kindMap);
    await closePool();
    return;
  }

  while (true) {
    try {
      const processed = await runOnce(kindMap);
      if (processed === 0) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ level: "error", message }));
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

void main().catch(async (err) => {
  console.error("[extraction-worker] fatal", err);
  await closePool();
  process.exit(1);
});
