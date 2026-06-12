# Changelog

All notable changes to Myco Brain are documented here. This project follows
[Semantic Versioning](https://semver.org/). **Tool contracts are stable within
a major version** — the inputs and outputs of the `brain_*` MCP tools will not
break in a 1.x release.

## [1.1.0] — 2026-06-11

### Fixed
- **Relation endpoint recovery — graph edges now survive small-model
  extraction.** Small local models frequently emit a correct relation while
  omitting one endpoint from `entities`; the worker's anti-hallucination
  guard (relations never create entities) then silently dropped the edge.
  Measured on the gold fixture with `llama3.2:3b`: **0% of emitted relations
  had both endpoints listed — i.e. zero graph edges survived** on a fresh
  keyless install. `extract()` now runs a best-effort second pass that asks
  the model to classify exactly the missing endpoint names against the same
  text (example-anchored prompt; anything beyond the requested names is
  discarded). Edge survival: **0% → 79%**, direction accuracy unchanged at
  93%; the remainder are junk phrase-objects that are correctly rejected.
  The direction check now also measures and gates **endpoint completeness**
  (`BRAIN_ENDPOINT_MIN_COMPLETENESS`, default 0.75).

### Changed
- **Relationship extraction is now direction-aware.** The extraction prompt
  states that relations are directed (`subject → predicate → object`), defines
  subject vs. object, and gives worked directional examples (including the
  passive-voice trap that flips small models). On the gold fixture this lifts
  `llama3.2:3b` direction accuracy from ~79% to ~93%. The prompt and provider
  calls moved to `extraction.ts` (importable without starting the worker loop).

### Added
- **Strict curation mode.** `BRAIN_REQUIRE_HUMAN_REVIEW=1` disables all
  auto-promotion: every extracted entity and relation waits in the review
  queue (`proposed_*`, state=`pending`) and nothing reaches the canonical
  graph without a human decision — the LLM writes proposals, the human writes
  the graph. Covered by a differential end-to-end check
  (`npm run test:strict-mode`, no LLM required).
- **Seeded relationship-type catalog.** Migration `20260611000048` seeds
  `relation_types` with the eight canonical predicates the extraction prompt
  teaches (idempotent; tolerant of `ASSIGNED_TO`-style naming from existing
  deployments). The dynamic-schema known-predicate filter now has a real
  baseline instead of an empty catalog.
- **Dynamic schema (phase 1) — propose and surface.** The extraction worker now
  records entity kinds and relationship predicates it observes that aren't in
  the `entity_kinds` / `relation_types` catalogs as **pending**
  `schema_proposals` rows (provenance-tagged, deduped per workspace by the
  unique type+name constraint; min confidence via
  `BRAIN_SCHEMA_PROPOSAL_MIN_CONFIDENCE`, default 0.6, inclusive). `brain_stats`
  gains a `schema` section and the summary surfaces *"Brain proposed N new
  types from your data (pending review)"*. Promotion stays manual — nothing
  auto-applies: entities with a not-yet-cataloged kind stay in the review queue
  and are **not** auto-promoted into the canonical graph (so a novel "product"
  can never be mislabeled as an organization or fuzzy-merged into one).
  Migration `20260611000047` (idempotent) extends the `proposal_type` CHECK
  with `entity_kind`; the proposal write runs under a savepoint, so a database
  that hasn't applied the migration degrades to "no proposals recorded" instead
  of failing extraction. The extraction prompt now lets the model name a novel
  kind when none of the canonical four fits; the prompt's own example
  predicates are treated as canonical and never proposed as "new".
- **Direction regression test.** `src/extraction-direction.ts` defines a
  gold fixture of clearly-directed facts (from `examples/demo-corpus`, with
  passive-voice traps) and a `scoreDirection` scorer (deterministic unit tests
  in `extraction-direction.test.ts`). `test/extraction-direction-check.mjs`
  (`npm run test:direction`) measures a model's directed accuracy and fails
  below `BRAIN_DIRECTION_MIN_ACCURACY` (default 0.8); it skips when no real
  extraction model is configured, so the keyless CI quickstart is unaffected.
- Recommended-model + measured-accuracy note in `docs/relationship-extraction.md`.
- **Local (keyless) vector search** via Ollama `nomic-embed-text` (768d),
  selected with `BRAIN_EMBED_PROVIDER=ollama` (auto-selected when an Ollama
  base URL is configured and no OpenAI key is present). Runs alongside the
  existing OpenAI `text-embedding-3-small` (1536d) path; each provider stores
  vectors in its own table (`chunks_ollama_nomic` / `chunks_openai3small`), so
  switching providers never causes a dimension clash. `brain_search`,
  `brain_context_pack`, and `brain_recall_memory` join the active provider's
  table, and `brain_stats` counts embedded chunks across both. Migration
  `20260611000046_chunks_ollama_nomic.sql` (idempotent) adds the 768d table.
  Semantic search now works with no hosted API key at all.


## [1.0.0]

First public release.

### Added
- Self-hosted MCP server exposing **11 tools** (`brain_context_pack`,
  `brain_search`, `brain_why`, `brain_neighbors`, `brain_ingest`,
  `brain_propose_fact`, `brain_annotate`, `brain_save_memory`,
  `brain_recall_memory`, `brain_get_related`, `brain_stats`).
- Postgres 16 + pgvector schema (42 migrations) with a seeded default
  workspace so `docker compose up` works with zero configuration.
- Keyless full-text (BM25) search and document ingestion — no API keys needed.
- Content-hash **deduplication** on ingest and queryable **provenance**
  (`brain_why`), with an evidence summary ("supported by N mentions across M
  sources").
- **Bulk ingest CLI** (`mycobrain-ingest`) for local folders and GitHub repos.
- **Knowledge graph**: entity extraction, entity resolution, and
  entity-to-entity relationships — built fully locally via Ollama (no API key)
  or via Anthropic for best accuracy.
- Reproducible dedup + provenance benchmark (`examples/benchmark/`).
- CI that boots the real Docker stack and runs all tools end-to-end.

### Notes
- Vector (semantic) search requires an OpenAI key; full-text search is keyless.
  Local embeddings are on the [roadmap](./ROADMAP.md).
- Managed cloud is waitlist-only and not part of this release.
