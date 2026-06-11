# Tool API Reference

Myco Brain exposes 11 MCP tools. A connected agent calls them by name; you
rarely call them by hand. This reference lists each tool's purpose, inputs, and
what it returns.

## Common fields

Every tool accepts these optional fields (normally supplied by the server's
environment, not per call):

- `workspace_id` (string) — workspace UUID; required only for service-role auth.
- `agent_id` (string) — overrides the agent ID derived from the API key.
- `api_key` (string) — overrides the `BRAIN_API_KEY` from the environment.

All write tools deduplicate and record provenance automatically. Tool contracts
are stable within a major version (see [CHANGELOG](../CHANGELOG.md)).

---

## Retrieval

### `brain_context_pack`
Primary context assembly — **call this first** when an agent needs information.
Runs hybrid retrieval and returns chunks, entities, people, session notes, and
relationships for a natural-language query.

- `query` (string, **required**) — natural-language query.
- `limit` (number) — max chunks (default 10, max 50).
- `context_token_budget` (number) — token budget for deterministic compaction.
- `include_entities` / `include_people` / `include_relational_context` (boolean, default true), `include_session_notes` (boolean, default false).
- `relational_limit` (number) — max relationship edges (default 25, max 100).
- `hyobject_types` (number[]) — filter by document type IDs.
- `embedding` (number[]) — pre-computed 1536-dim query embedding (optional).

**Returns:** `{ chunks, entities, people, session_notes, relational_context, query_meta, retrieval_metadata }`.

### `brain_search`
Hybrid search (vector + full-text) with structured filters.

- `query` (string, **required**).
- `filters` (object) — by `type_ids`, `people_ids`, `entity_ids`, `created_after`/`created_before`.
- `limit`, `offset` (number); `sort` (string: `score` | `date_desc` | `date_asc`).
- `embedding` (number[]) — optional pre-computed query embedding.

**Returns:** `{ results: [{ chunk_id, hyobject_id, hyobject_name, text, score, … }], total_estimated, retrieval_metadata }`. Works keyless (BM25); uses vectors when an embedding/`BRAIN_OPENAI_API_KEY` is available.

### `brain_recall_memory`
Recall an agent's **own** saved memories and session notes — **not** ingested
documents (use `brain_context_pack`/`brain_search` for those).

- `query` (string, **required**).
- `agent_id` (string) — scope to a specific agent's memories (default: caller's own).
- `limit` (number, default 10, max 50); `include_entities` (boolean).

**Returns:** `{ memories: [{ hyobject_id, name, text, score }], … }`.

---

## Provenance & graph

### `brain_why`
Provenance: where a fact came from — audit trail, source documents, promoted
proposals, and (for entities) an evidence summary.

- One of: `hyobject_id`, `entity_id`, `people_id` — trace a single record; **or** both `entity_a_id` and `entity_b_id` — pairwise provenance.
- `limit_vc` (number) — max audit-trail entries (default 20).

**Returns:** `{ subject, vc_trail, source_proposals, ingest_info, evidence }`. For an entity, `evidence` is `{ mention_count, source_document_count, summary }` (e.g. "Supported by 4 mentions across 4 source documents").

### `brain_neighbors`
Knowledge-graph traversal — the neighbourhood of a node.

- `node_id` (string, **required**); `node_kind` (string, **required**: `hyobject` | `entity` | `person`).
- `depth` (number); `relation_types` (string[]); `limit` (number).

**Returns:** connected nodes and edges (documents ↔ entities ↔ people, plus entity-to-entity relationships).

### `brain_get_related`
Related entities, documents, and provenance for a subject.

- `subject_id` (string, **required**); `subject_kind` (string, **required**).
- `limit` (number).

**Returns:** related nodes grouped by relationship, with source provenance.

### `brain_stats`
Memory-health snapshot.

- *(no required inputs)*

**Returns:** `{ summary, documents, entities, relations, entities_promoted, proposals_pending, source_backed_pct, idempotent_writes, … }` — e.g. *"12 documents · 48 graph facts (40 entities, 8 relations) · 100% source-backed · 0 pending review."*

---

## Writes (deduplicated, provenance-tracked)

### `brain_ingest`
Ingest text, a URL, or a file. Identical content is rejected by content hash.

- `mode` (string, **required**: `text` | `url` | `file`).
- `text` (mode=text) / `url` (mode=url) / `file_content_base64` + `file_name` (mode=file).
- `name`, `mime_type`, `tags` (object); `type_id`, `subtype_id`, `sharing_type_id` (number).

**Returns:** `{ hyobject_id, processing_state, name, storage_uri, message }`. `text` mode is searchable immediately; `url`/`file` are queued for the worker. For bulk ingestion of folders/repos, use the [`mycobrain-ingest` CLI](../README.md#bulk-ingest-a-folder-or-repo).

### `brain_save_memory`
Save an agent memory in one call (agent-scoped document + session note).
Immediately full-text searchable via `brain_recall_memory`.

- `content` (string, **required**).
- `tags` (object), `source_label` (string, default `agent_memory`).

**Returns:** `{ hyobject_id, chunk_id, session_note_id, … }`.

### `brain_annotate`
Leave a session breadcrumb (observation, decision, question, or fact).

- `kind` (string, **required**: `observation` | `decision` | `question` | `fact`); `content` (string, **required**).
- `session_id` (string, optional); `related_hyobject_id` (string).

**Returns:** `{ session_id, note_id }`. Retrieve via `brain_context_pack` with `include_session_notes=true`.

### `brain_propose_fact`
Propose a new entity or relationship into the review queue.

- `kind` (string, **required**: `entity` | `relation`).
- Entity: `canonical_name`, `entity_kind_id`, `aliases` (string[]), `source_hyobject_id`, `confidence`.
- Relation: `subject_kind`/`subject_id`, `object_kind`/`object_id`, `predicate` or `relation_type_id`, `confidence`.

**Returns:** `{ proposal_id, state }`. Confident proposals can auto-promote; otherwise they await review.
