# Changelog

All notable changes to Myco Brain are documented here. This project follows
[Semantic Versioning](https://semver.org/). **Tool contracts are stable within
a major version** — the inputs and outputs of the `brain_*` MCP tools will not
break in a 1.x release.

## [1.2.6] — 2026-06-17

An agent-experience release: the agent contract now teaches Myco as the
adjudication engine it is, and the doctor verifies your setup for real instead of
trusting config. **No tool-contract changes** (the `brain_*` inputs/outputs are
unchanged; `brain_ingest` gains an additive `extraction` field). No migrations.

### Changed
- **Agent contract rewritten to embody "the program writes the facts, not the
  LLM."** The runtime contract, the pasteable CLAUDE.md / .cursorrules / AGENTS.md
  manual, the `brain_*` tool descriptions, and the website now teach the
  source-first write ladder (ingest a source -> propose a claim -> private
  save_memory) and the engine's mechanics: compounding confidence across
  independent sources, supersede-don't-overwrite on conflict, provenance via
  `brain_why`, and propose -> review -> promote. `brain_save_memory` is honestly
  fenced as a private scratchpad, never workspace truth. The runtime contract is
  single-sourced so the surfaces cannot drift (CI guard: `npm run check:contract-drift`).

### Added
- **`mycobrain-doctor` now verifies live, not just config.** For the local Ollama
  path it pings the server, confirms the model is pulled, and runs a real embed
  and generation ("live-verified"); it adds an extraction-backlog check and a
  `--fix` mode that offers to pull missing models. `brain_ingest` returns an
  honest `extraction: "graph" | "search-only"` receipt so an agent knows whether
  a fact graph was actually built from the source.
- **Agent-contract eval harness** (`npm run eval:contract`, gated on
  `ANTHROPIC_API_KEY`): scores whether an agent routes to the right tool across 20
  adversarial scenarios, so the contract is measured and regression-guarded.

## [1.2.5] — 2026-06-17

A frictionless-install and value-surfacing release. **No tool-contract changes** —
every `brain_*` input is unchanged; the new response fields below are additive and
optional. No migrations.

### Added
- **`npx @mycobrain/install` — one command to connect any client.** A new
  installer (`mycobrain-install`, fronted by the `@mycobrain/install` launcher)
  detects your MCP client and writes the right config for Claude Code, Claude
  Desktop, Cursor, Codex, or Windsurf (with `--print` snippets for Zed, Continue,
  Cline), then runs onboarding. Flags: `--client`, `--all`, `--print`, `--scope`,
  `--no-onboard`.
- **Onboarding now indexes your own repo (opt-in).** On a fresh brain,
  `mycobrain-onboard` asks before indexing the current project, then proves recall
  on your own code in a fresh context — the fastest felt "it just knew", with no
  export wait. Decline to leave the workspace untouched; `--tour` runs on
  throwaway sample data instead.
- **"Recalled from your memory" attribution.** `brain_recall_memory` and
  `brain_context_pack` attach an optional `attribution` credit line that decays as
  the workspace matures (`BRAIN_ATTRIBUTION`, `BRAIN_ATTRIBUTION_DECAY`). It rides
  in a structured field, never the result body.
- **Pushed stats.** `brain_context_pack` adds a once-per-session `session_greeting`
  ("Myco has N facts indexed for this workspace"); `brain_save_memory` adds a
  log-spaced `milestone` toast (10/50/100/250, then every 250).
- **`mycobrain-ingest --watch-downloads`.** Opt-in watcher that auto-imports a
  ChatGPT or Claude export `.zip` the moment it lands in `~/Downloads`.
- **Paste-anywhere agent instructions.** `mycobrain-install` prints, and
  `docs/agent-instructions.md` documents, a portable CLAUDE.md / `.cursorrules` /
  AGENTS.md contract for when to recall, save, and cite.

## [1.2.4] — 2026-06-16

A reliability, security, and docs release. **No tool-contract changes** — the
`brain_*` MCP tool inputs and outputs are unchanged. **Includes two database
migrations** (`052`, `053`); apply on upgrade. (The `1.2.3` release was a docs-only
benchmark correction; this release ships the prelaunch engine hardening that landed
afterward.)

### Fixed
- **Extraction-worker durability.** A worker that crashed or restarted mid-chunk
  left that chunk stranded in `processing` forever, and a retry-exhausted chunk was
  mislabeled `pending` instead of `failed`. The worker now reclaims stale
  `processing` chunks once their lease expires and marks retry-exhausted chunks
  terminally `failed`. *Proof: `npm run test:reliability`.*
- **Contradiction / supersession robustness.** Concurrent contradictions of the
  same functional fact are serialized (no two active objects can result), predicate
  matching is separator-insensitive (`reports_to` ≡ `reports to`), and the claims
  ledger no longer duplicates on re-fired contradictions. *Proof: `npm run test:contradiction`.*
- **Schema-proposal corroboration counts distinct documents.** `seen_count` is
  derived from the true distinct-source set, so two documents alternating can no
  longer reach the auto-promote gate; `brain_why` source counts are per fact, not
  per edge row. *Proof: `npm run test:proposal-sources`.*

### Changed
- **Workspace-scoped dynamic type catalogs.** Under `BRAIN_SCHEMA_AUTO_PROMOTE=1`, a
  workspace's auto-promoted entity-kind / relation-type names were written into the
  global catalog (visible to other workspaces). Promoted types are now scoped to
  their workspace; the canonical seed stays global. *Proof: `npm run test:schema-promotion`.*

### Security
- **`form-data` advisory (CRLF injection).** Resolved the transitive `form-data`
  dependency pulled via `@anthropic-ai/sdk`; `npm audit` reports 0 vulnerabilities.
- **stdio auth hardened (defense-in-depth).** The stdio MCP server now derives
  agent/workspace identity from the environment and ignores caller-supplied
  `api_key` / `workspace_id` / `agent_id` by default — set
  `BRAIN_TRUST_REQUEST_IDENTITY=1` to opt back in for a real multi-tenant gateway —
  and a service-role JWT must now **equal** `BRAIN_SERVICE_ROLE_KEY` rather than
  merely look like a JWT. Closes a prompt-injection path to another workspace in a
  multi-tenant deployment; no change for single-tenant self-host (identity already
  came from env). *Proof: `auth.test.ts`.*

### Docs
- README / SECURITY: honest RLS/superuser disclosure (the default `brain` role is a
  Postgres superuser that bypasses RLS — multi-tenant isolation binds only under the
  least-privilege `brain_app` role), edge survival cited as **~80% (11–12 of 14,
  ≥75% gate)** rather than a bare 79%, and a reframed comparison table. Documented
  the `brain_search` `reranker` argument. The LongMemEval headline (73.6% oracle QA)
  is now backed by committed n=500 result files so it reproduces from a clone.
- Added a consolidated **environment-variable reference** to the README and
  documented the identity vars `BRAIN_TRUST_REQUEST_IDENTITY`, `BRAIN_AGENT_ID`, and
  `BRAIN_SERVICE_ROLE_KEY` (with a matching `.env.example`); corrected the
  api-reference note that per-call `workspace_id`/`api_key` are honored on stdio
  (they are ignored by default post stdio-auth hardening).

### Migrations
- `20260616000052_workspace_scoped_catalogs.sql`
- `20260616000053_schema_proposal_distinct_sources.sql`

## [1.2.3] — 2026-06-16

A documentation-accuracy release. **No code or tool-contract changes** — purely a
correction to a published benchmark figure, in keeping with our rule that every
number we publish reproduces on the full set.

### Fixed
- **recall@5 corrected to the full 500-question run.** The recency-reranker
  recall@5 figures introduced in 1.2.2 ("86% → ~92%") were measured on a
  **100-question sample**. Re-run on the **full 500-question** LongMemEval
  `longmemeval_s` set, the numbers are **89.2%** (default `hybrid`) → **91.6%**
  (`recency`) — the default is actually *higher* than the sample showed, and the
  reranker holds ~92%. Independently re-run end-to-end and reproduced **exactly**
  (zero drift; retrieval is deterministic). Reproduce:
  `python -m evals.longmemeval.run --subset longmemeval_s -n 500 --no-qa`
  (compare the `hybrid` and `temporal` rows, `ev_at_5`).

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
