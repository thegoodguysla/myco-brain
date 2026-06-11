# Changelog

All notable changes to Myco Brain are documented here. This project follows
[Semantic Versioning](https://semver.org/). **Tool contracts are stable within
a major version** — the inputs and outputs of the `brain_*` MCP tools will not
break in a 1.x release.

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
