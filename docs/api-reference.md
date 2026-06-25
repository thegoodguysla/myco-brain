# Tool API Reference

Myco Brain exposes 13 MCP tools. A connected agent calls them by name; you
rarely call them by hand. This reference lists each tool's purpose, inputs, and
what it returns.

## Common fields

Every tool accepts these optional fields, but on the **stdio** server they are
**ignored by default** — identity comes only from the server's environment (and,
for `brain_` keys, the key itself), so a prompt-injected agent can't pass its own
`workspace_id` to reach another workspace. Set `BRAIN_TRUST_REQUEST_IDENTITY=1`
(multi-tenant gateways only) to honor them per call. The networked REST server
only ever accepts `brain_` keys.

- `workspace_id` (string) — workspace UUID; honored only for service-role auth or under `BRAIN_TRUST_REQUEST_IDENTITY=1`.
- `agent_id` (string) — overrides the agent ID derived from the API key (same condition).
- `api_key` (string) — overrides the `BRAIN_API_KEY` from the environment (same condition).

All write tools deduplicate and record provenance automatically. Tool contracts
are stable within a major version (see [CHANGELOG](../CHANGELOG.md)).

**Privacy:** documents ingested with `sharing_type_id = 1` (`private`) are
visible only to the agent that created them (and service-role callers) across
all read tools. The default (`2`, `workspace`) is visible to every agent in
the workspace.

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
- `reranker` (string: `none` | `cohere` | `recency`, default `none`) — optional post-retrieval reordering. `recency` is **keyless and deterministic** (`final = 0.7·relevance + 0.3·recency_norm`) with no API key or network call; `cohere` uses the Cohere API when `COHERE_API_KEY` is set.

**Returns:** `{ results: [{ chunk_id, hyobject_id, hyobject_name, text, score, … }], total_estimated, retrieval_metadata }`. Works keyless (BM25); uses vectors when an embedding/`BRAIN_OPENAI_API_KEY` is available. The `recency` reranker lifts recall@5 on the full 500-question LongMemEval `longmemeval_s` set from 89.2% (default hybrid) to 91.6%.

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

**Returns:** `{ summary, storage, graph, review, schema, evidence, provenance, reliability, agents }` — e.g. *"12 documents · 48 graph facts (40 entities, 8 relations) · 100% source-backed · 0 pending review · Brain proposed 2 new types from your data (pending review) · evidence: 3 multi-source facts, 1 superseded."*

The `schema` section is dynamic schema: `{ proposed_types_pending, entity_kinds_pending, relation_types_pending, types_auto_promoted }` — entity kinds and relationship types the extraction worker observed in your data that aren't in the catalogs yet (`schema_proposals`), plus how many earned catalog promotion under the corroboration rules. Promotion is manual by default (`BRAIN_SCHEMA_AUTO_PROMOTE=1` opts in).

The `evidence` section is **compounding confidence**: `{ relations_corroborated, relations_superseded, mean_relation_confidence }` — facts backed by 2+ independent source documents, facts closed by contradiction (superseded, never overwritten), and the mean confidence across active graph edges. In pairwise `brain_why`, each direct relation additionally reports `independent_sources` and an audited `confidence_trend` (e.g. `"0.8 → 0.86"`), and `superseded_relations` lists contradicted history.

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

## Surfacing & self-check

### `brain_set_mode`
Set how loudly Myco surfaces that memory engaged. Silent by default.

- `mode` (string: `silent` | `ambient` | `audit`). silent = invisible, ~0 tokens; ambient = one cheap status line when a memory shaped the answer; audit = full provenance, for client/legal/financial work.
- `scope` (object, optional): `{ project }` to narrow what Myco draws on; `null` clears it.
- `persist` (boolean, default `true`): `true` saves it as the workspace default so it follows you across clients; `false` applies to this session only.

**Returns:** `{ mode, persisted }`.

### `brain_self_check`
Pull-only health check: the "self-check that talks." Costs tokens only when invoked, so call it at session start (in ambient/audit) or when asked "how's the brain?".

- `pending_limit` (number, default `5`, max `25`): max pending approvals to return inline.

**Returns:** `{ mode, working, pending, problems, summary }`. `working` reports live document/chunk/embedded counts plus a per-source-agent breakdown (`by_source`); `pending` lists items awaiting your approval; `problems` is a list of `{ id, severity, title, detail, fix }` (for example, semantic search off, embeddings behind, extraction backlog), each with a concrete fix.
