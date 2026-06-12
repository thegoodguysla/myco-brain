import "dotenv/config";

import type pg from "pg";
import Anthropic from "@anthropic-ai/sdk";
import { closePool, withSession } from "./db.js";
import { resolveAuth } from "./auth.js";
import {
  clampConfidence,
  type ExtractionOutput,
} from "./extraction-worker.lib.js";
import { extract } from "./extraction.js";
import {
  collectSchemaProposals,
  normalizeTypeName,
  persistSchemaProposals,
  schemaProposalMinConfidence,
} from "./schema-proposals.js";
import { rescoreEntityRelation } from "./confidence.js";
import { supersedeContradictedRelations } from "./contradiction.js";
import { autoPromoteSchemaProposals } from "./schema-promotion.js";

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

// Strict curation mode: nothing the LLM proposes is auto-promoted into the
// canonical graph — every entity and relation waits in proposed_* (pending)
// for human review. This is the upstream-Hyperscope contract ("the LLM writes
// descriptions, the human decides") as a switch. Note: relations can only be
// queued between entities that already exist in the canonical graph, so on a
// fresh strict-mode workspace, approve entities first and relations will
// queue on subsequent extractions.
const REQUIRE_HUMAN_REVIEW = process.env.BRAIN_REQUIRE_HUMAN_REVIEW === "1";

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

// Known relation-type names — predicates outside this catalog get recorded as
// schema_proposals. Loaded once per run, like the kind map. Names are run
// through normalizeTypeName so catalog conventions like "ASSIGNED_TO" compare
// equal to extracted phrases like "assigned to".
async function mapKnownPredicates(): Promise<Set<string>> {
  return withSession(auth.ctx, async (client) => {
    const res = await client.query<{ name: string }>(
      `SELECT name FROM relation_types`,
    );
    const known = new Set<string>();
    for (const row of res.rows) {
      const n = normalizeTypeName(row.name);
      if (n) known.add(n);
    }
    return known;
  });
}

async function extractEntities(text: string): Promise<ExtractionOutput> {
  // Provider calls + the shared prompt live in extraction.ts so they can be
  // imported (e.g. by the gold-fixture direction check) without starting this
  // worker's polling loop.
  return extract(text.slice(0, MAX_TEXT_CHARS), {
    provider: EXTRACTION_PROVIDER,
    anthropic,
    anthropicModel: MODEL,
    ollamaBaseUrl: OLLAMA_BASE_URL,
    ollamaModel: OLLAMA_MODEL,
  });
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
  knownPredicates: Set<string>,
): Promise<void> {
  const threshold = await getAutoPromoteThreshold();
  await withSession(auth.ctx, async (client) => {
    let promoted = 0;
    // Names (and aliases) promoted in this chunk → entity_id, for resolving the
    // endpoints of relations extracted from the same chunk.
    const nameToEntityId = new Map<string, string>();

    for (const entity of output.entities) {
      const catalogKindId = kindMap.get(entity.kind?.toLowerCase?.() ?? "");
      // Novel kinds (not in the entity_kinds catalog) are stored in the review
      // queue under the organization fallback id, but are NEVER auto-promoted:
      // the kind itself is only a pending schema proposal, and promoting the
      // instance under a wrong kind would both mislabel the canonical graph
      // and let the kind-scoped entity-resolution merge, say, a product into
      // an organization node. They wait for manual review.
      const kindId = catalogKindId ?? kindMap.get("organization") ?? 1;
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
      // Only catalog kinds are eligible (see the novel-kind note above), and
      // strict curation mode disables promotion entirely.
      if (confidence >= threshold && catalogKindId !== undefined && !REQUIRE_HUMAN_REVIEW) {
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
    let relationsSuperseded = 0;
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
         VALUES ($1, 'entity', $2, 'entity', $3, $4, $5, $6, $7, $8)`,
        [
          chunk.workspaceId,
          subjectId,
          objectId,
          rel.predicate,
          chunk.hyobjectId,
          EXTRACTOR_LABEL,
          relConfidence,
          REQUIRE_HUMAN_REVIEW ? "pending" : "auto_promoted",
        ],
      );
      // Strict curation mode: the relation waits in the review queue; no
      // canonical graph edge is written.
      if (REQUIRE_HUMAN_REVIEW) continue;

      // entity_relations is the promoted graph edge. Find-or-create (one
      // ACTIVE edge per pair + predicate — a superseded edge stays closed;
      // re-assertion opens a fresh validity interval), keeping the id so
      // evidence can link to it.
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM entity_relations
          WHERE workspace_id = $1 AND entity1_id = $2 AND entity2_id = $3 AND predicate = $4
            AND (valid_to IS NULL OR valid_to > now())
          LIMIT 1`,
        [chunk.workspaceId, subjectId, objectId, rel.predicate],
      );
      let relationRowId = existing.rows[0]?.id ?? null;
      if (!relationRowId) {
        const ins = await client.query<{ id: string }>(
          `INSERT INTO entity_relations
             (workspace_id, entity1_id, entity2_id, predicate, source_hyobject_id, confidence)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [chunk.workspaceId, subjectId, objectId, rel.predicate, chunk.hyobjectId, relConfidence],
        );
        relationRowId = ins.rows[0].id;
        relationsAdded++;
      }

      // Compounding confidence: every sighting is recorded as evidence — the
      // old NOT EXISTS de-dupe silently DISCARDED re-extractions, which is
      // exactly the corroboration signal. One evidence row per source
      // document per edge (re-extractions from other chunks of the same doc
      // are not independent corroboration), then the edge's confidence is
      // recomputed from all independent sources, so it RISES as new documents
      // agree.
      await client.query(
        `INSERT INTO relation_evidence
           (workspace_id, relation_kind, relation_row_id, source_node_id, target_node_id,
            predicate, evidence_hyobject_id, evidence_chunk_id, confidence, evidence_kind)
         SELECT $1, 'entity_relation', $2, $3, $4, $5, $6, $7, $8, 'extraction'
         WHERE NOT EXISTS (
           SELECT 1 FROM relation_evidence
            WHERE workspace_id = $1 AND relation_kind = 'entity_relation'
              AND relation_row_id = $2 AND evidence_hyobject_id = $6
         )`,
        [
          chunk.workspaceId,
          relationRowId,
          subjectId,
          objectId,
          rel.predicate,
          chunk.hyobjectId,
          chunk.chunkId,
          relConfidence,
        ],
      );
      await rescoreEntityRelation(
        client,
        chunk.workspaceId,
        subjectId,
        objectId,
        rel.predicate,
      );

      // Contradiction: a confident observation on a FUNCTIONAL predicate
      // supersedes (closes + weakens, never overwrites) any active edge that
      // asserts a different current object — recorded in the claims ledger.
      const conflict = await supersedeContradictedRelations(
        client,
        chunk.workspaceId,
        subjectId,
        rel.predicate,
        objectId,
        relConfidence,
        chunk.hyobjectId,
        EXTRACTOR_LABEL,
      );
      relationsSuperseded += conflict.superseded;
    }

    // Dynamic schema (phase 1): record kinds/predicates we observed that the
    // catalogs don't know about. Pending-only — promotion is manual; the
    // unique (workspace, type, name) constraint dedupes repeat sightings.
    const schemaCandidates = collectSchemaProposals(
      output,
      new Set(kindMap.keys()),
      knownPredicates,
      schemaProposalMinConfidence(),
    );
    let schemaProposed = 0;
    if (schemaCandidates.length) {
      // Best-effort under a SAVEPOINT: proposals are telemetry, and they must
      // never take down the chunk's extraction output. Concretely: on a DB
      // that hasn't applied migration 20260611000047 yet, inserting
      // proposal_type='entity_kind' violates the old CHECK (SQLSTATE 23514)
      // and would otherwise roll back this whole transaction and burn the
      // chunk's retry attempts. (A plain try/catch is not enough — the
      // transaction is aborted until rolled back to a savepoint.)
      await client.query("SAVEPOINT schema_proposals");
      try {
        schemaProposed = await persistSchemaProposals(
          client,
          chunk.workspaceId,
          chunk.hyobjectId,
          EXTRACTOR_LABEL,
          schemaCandidates,
        );
        await client.query("RELEASE SAVEPOINT schema_proposals");
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT schema_proposals");
        console.error(
          JSON.stringify({
            level: "warn",
            message: `schema proposal write skipped: ${
              err instanceof Error ? err.message : String(err)
            }`,
          }),
        );
      }
    }

    await client.query(
      `UPDATE chunk_extraction_status
       SET status = 'succeeded',
           extracted_at = now(),
           last_error = NULL,
           metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('entity_count', $2::int, 'promoted_count', $3::int, 'relation_count', $4::int, 'schema_proposed_count', $5::int, 'superseded_count', $6::int)
       WHERE chunk_id = $1`,
      [chunk.chunkId, output.entities.length, promoted, relationsAdded, schemaProposed, relationsSuperseded],
    );
  });
}

async function processOne(
  chunk: ClaimedChunk,
  kindMap: Map<string, number>,
  knownPredicates: Set<string>,
): Promise<void> {
  try {
    const output = await extractEntities(chunk.text);
    await persistSuccess(chunk, output, kindMap, knownPredicates);
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

async function runOnce(
  kindMap: Map<string, number>,
  knownPredicates: Set<string>,
): Promise<number> {
  const batch = await claimBatch();
  if (batch.length === 0) return 0;

  for (const chunk of batch) {
    await processOne(chunk, kindMap, knownPredicates);
  }

  return batch.length;
}

// Full dynamic schema: promote corroborated proposals into the live catalogs
// (gated by BRAIN_SCHEMA_AUTO_PROMOTE; see schema-promotion.ts). Returns true
// when something promoted, so the caller can refresh its catalog caches —
// a newly promoted entity kind is usable by the very next batch.
async function maybeAutoPromoteSchema(): Promise<boolean> {
  const promoted = await withSession(auth.ctx, (client) =>
    autoPromoteSchemaProposals(client, auth.ctx.workspaceId),
  );
  for (const p of promoted) {
    console.log(
      JSON.stringify({ event: "schema_auto_promoted", type: p.proposal_type, name: p.name, applied_id: p.applied_id }),
    );
  }
  return promoted.length > 0;
}

async function main(): Promise<void> {
  let kindMap = await mapEntityKindIds();
  let knownPredicates = await mapKnownPredicates();
  const once = process.argv.includes("--once");

  if (once) {
    await runOnce(kindMap, knownPredicates);
    await maybeAutoPromoteSchema();
    await closePool();
    return;
  }

  while (true) {
    try {
      const processed = await runOnce(kindMap, knownPredicates);
      if (processed > 0 && (await maybeAutoPromoteSchema())) {
        kindMap = await mapEntityKindIds();
        knownPredicates = await mapKnownPredicates();
      }
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
