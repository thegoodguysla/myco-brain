# Changelog

All notable changes to Myco Brain are documented here. This project follows
[Semantic Versioning](https://semver.org/). **Tool contracts are stable within
a major version** — the inputs and outputs of the `brain_*` MCP tools will not
break in a 1.x release.

## [1.2.2] — 2026-06-16

A retrieval-quality release. No tool-contract changes (the reranker is an
optional, additive `brain_search` argument).

### Added
- **Keyless recency reranker.** `brain_search(reranker: 'recency')` reorders
  results by `final = 0.7·relevance + 0.3·recency_norm` — deterministic, no API
  key, no network call. Lifts recall@5 from 86% to ~92% on the LongMemEval
  `longmemeval_s` subset (the recency reranker scores ~92% recall@5 in the eval
  harness, which mirrors the production retrieval path and runs the identical
  formula). 15/15 reranker tests pass; reproduce with
  `python -m evals.longmemeval.run --subset longmemeval_s --no-qa` (compare the
  `hybrid` and `temporal` rows).

### Fixed
- **Eval robustness.** Embedder inputs are sanitized so a single bad batch can
  no longer silently skew benchmark results.
- **README accuracy.** The relation edge-survival figure is corrected to
  `0% → 79%` (86% is the directed-extraction accuracy, not edge survival).

## [1.2.1] — 2026-06-13

A reliability, security, and onboarding release. No tool-contract changes.

### Added
- **Import your ChatGPT / Claude history.** `mycobrain-ingest --from
  chatgpt-export ./export.zip` and `--from claude-export ./export.zip` turn
  an OpenAI or claude.ai data export into provenance-tracked, deduplicated,
  searchable memory — one document per conversation. ChatGPT branched
  conversations import the ACTIVE transcript (not rejected regenerations);
  re-importing the same export never duplicates (content-hash dedup);
  `brain_why` traces every imported fact back to its export file.
  Proof: `npm run test:export-import`.
- **Out-of-box agent instructions.** The MCP server now ships a usage
  contract (`instructions`) to every connected client at initialization, so
  agents know WHEN to recall, save, and cite without per-project setup. Plus a
  copy-paste behavioral block in `docs/agent-setup.md`.
- **Demo corpus contradiction + "magic moment."** The bundled demo corpus
  carries a deliberate contradiction (a person changes employers); with the
  keyless local graph running, the trust engine supersedes the old fact
  (kept, not deleted) and `brain_why` shows both sources — supersession on
  the user's own ingested data, not a scripted demo.

### Fixed
- **`brain_save_memory` works out of the box.** Previously failed with
  "Validation error: Required" because `idempotency_key` / `trace_id` /
  `raw_payload` were required but not advertised; they now auto-default.
- **Security — agent identity comes only from the key.** For `brain_*` API
  keys, caller-supplied `workspace_id` / `agent_id` tool arguments are now
  ignored (they could let one agent impersonate another and read its private
  memories); identity overrides remain a service-role-only privilege.
  `api_key`/secrets are redacted before being written to the `brain_queries`
  audit table, and the docker-compose ports bind to `127.0.0.1`. Regression
  in `npm run test:sharing`.
- **Local-model extraction hardening.** Ollama calls cap generation and time
  out (no more runaway-loop stalls that froze the extraction queue), retry
  transient drops, and recover facts from truncated JSON; relation predicates
  are canonicalized (so `now works for` matches `works for` for supersession),
  duplicate triples deduped, and sub-threshold relations queue for review
  instead of being silently dropped.
- **Onboarding friction.** The README hero block now runs verbatim from a
  fresh clone (the ingest CLI defaults to the quickstart stack when no env is
  set); a "Connect your client" section leads with a Claude Code one-liner.
- **Honesty/accuracy.** Server version is read from `package.json`; the
  direction-accuracy figure is corrected to the re-measured **86%** (the
  confidence-emission prompt fix traded a few fixture points to unblock the
  trust engine on local models); an internal ticket id was removed from a
  tool description.

## [1.2.0] — 2026-06-12

### Added
- **Full dynamic schema — gated auto-promotion.** The propose-and-surface
  loop (phase 1) now completes: proposals corroborated by enough DISTINCT
  documents (`seen_count`, tracked per source) at high confidence
  **auto-promote into the live catalogs** (`entity_kinds` /
  `relation_types`) — and the promoted type is immediately usable by the next
  extraction batch. Strictly opt-in (`BRAIN_SCHEMA_AUTO_PROMOTE=1`, thresholds
  `BRAIN_SCHEMA_PROMOTE_MIN_SEEN`=3 / `BRAIN_SCHEMA_PROMOTE_MIN_CONFIDENCE`=0.8);
  strict curation mode always wins. Audit trail lives on the proposal row
  (`extracted_by`, evidence counts, `state='auto_promoted'`, `applied_id`,
  `reviewed_at`); `brain_stats.schema` gains `types_auto_promoted`. Covered by
  the full-loop gated check `npm run test:schema-promotion` (default-off
  verified, promotion verified, promoted-kind-becomes-usable verified — no LLM
  required) plus 8 unit tests. Migration `20260612000049` (idempotent) adds
  the corroboration counter.
- **Compounding confidence — the full engine.** A fact's confidence now
  **rises with independent corroboration and falls on contradiction**, and
  contradicted facts are **superseded, never silently overwritten**:
  - *Corroboration*: every relation sighting is recorded as
    `relation_evidence` (one row per source document per edge — re-extractions
    used to be silently discarded); the edge's confidence is recomputed with a
    damped noisy-OR anchored on the strongest source (α=0.4, cap 0.95; a
    single-source edge keeps exactly the confidence extraction gave it).
  - *Contradiction*: on **functional predicates** (one current object per
    subject — defaults `works for`, `reports to`, `located in`; extend via
    `BRAIN_FUNCTIONAL_PREDICATES`), a confident conflicting observation closes
    the old edge (`valid_to`), weakens it (`conf × (1 − α·c)`), and records the
    supersession in the **claims ledger** (`superseded_by` chain) — history
    stays queryable.
  - *Surfaces*: `brain_why` pairwise provenance gains `independent_sources`,
    a `confidence_trend` derived from the `vc` audit trail (e.g.
    `"0.8 → 0.86"`), and a `superseded_relations` list (contradictions are
    visible, not hidden). `brain_stats` gains an `evidence` section
    (corroborated / superseded counts, mean edge confidence) and a summary
    clause. All additive — no tool contract changes.
  - Covered by `npm run test:compounding` (full lifecycle end-to-end against a
    live DB, no LLM needed) plus 17 new unit tests; proven live with
    `ollama:llama3.2:3b` (two documents asserting different employers → old
    edge `[SUPERSEDED]`, new edge `[ACTIVE]`, claims chain recorded). The
    LongMemEval harness never runs extraction, so the benchmark number is
    structurally unaffected.
- **Per-object sharing enforcement.** Documents marked `private`
  (`sharing_type_id = 1`) are now actually private: readable only by the agent
  that created them (plus service-role callers) across `brain_search`,
  `brain_context_pack`, `brain_recall_memory`, `brain_why`, `brain_neighbors`,
  and `brain_get_related`. Ingest now records the creating agent
  (`hyobjects.agent_id`); private rows with no recorded creator stay hidden
  from non-service callers (conservative by design). Workspace/org/public/
  llm_readable documents behave exactly as before. Covered by a two-agent
  visibility-matrix check (`npm run test:sharing`, no LLM required).
- **LongMemEval benchmark harness ships in-repo** (`evals/longmemeval/`) so the
  headline number is reproducible by anyone, not asserted: **73.6% end-to-end
  QA accuracy on the complete 500-question `oracle` subset** (no sampling) with
  **100% evidence-retrieval recall** — reader `gpt-4o-mini`, judge `gpt-4o`.
  Self-contained Python harness (own `requirements.txt`, offline unit tests,
  per-question workspace isolation, automatic purge); methodology and
  per-category breakdown in `evals/longmemeval/README.md`; README gains a
  "Benchmark — run it yourself" section.


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
  86%; the remainder are junk phrase-objects that are correctly rejected.
  The direction check now also measures and gates **endpoint completeness**
  (`BRAIN_ENDPOINT_MIN_COMPLETENESS`, default 0.75).

### Changed
- **Relationship extraction is now direction-aware.** The extraction prompt
  states that relations are directed (`subject → predicate → object`), defines
  subject vs. object, and gives worked directional examples (including the
  passive-voice trap that flips small models). On the gold fixture this lifts
  `llama3.2:3b` direction accuracy from ~79% to ~86%. The prompt and provider
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
