# Roadmap

Myco Brain ships a deliberately small, rock-solid core and grows in the open.
This is where things are headed. Dates are intentionally omitted — this is
direction, not a contract. Issues and PRs that move these forward are welcome.

## Now — shipping today

- **Self-hosted MCP memory server** — 11 tools over MCP, backed by your own
  Postgres 16 + pgvector. Boots with one `docker compose up`.
- **Keyless full-text search & ingestion** — BM25 search and document ingestion
  work with zero API keys.
- **Content-hash deduplication** — identical content is rejected on write, so
  re-ingesting a folder never multiplies your memory.
- **Provenance** — every accepted fact links back to its source (`brain_why`).
- **Bulk ingest** — point `mycobrain-ingest` at a local folder or a GitHub repo.
- **Knowledge graph (local or hosted)** — entity extraction, entity resolution
  (duplicate names collapse into one node), and entity-to-entity relationships.
  Build it **fully locally with Ollama (no API key)** or, for best accuracy,
  with Anthropic.
- **Local vector search (no API key)** — semantic search via local embeddings
  (`nomic-embed-text` on Ollama, `BRAIN_EMBED_PROVIDER=ollama`), alongside the
  existing OpenAI path. Both keyless full-text and keyless semantic search now
  work with zero hosted dependencies.
- **Dynamic schema (full)** — the extraction worker proposes new entity kinds
  and relationship types it observes in your data (`schema_proposals`,
  surfaced by `brain_stats`), and — under explicit opt-in
  (`BRAIN_SCHEMA_AUTO_PROMOTE=1`) — proposals corroborated across enough
  independent documents auto-promote into the live catalogs with a full audit
  trail. The schema evolves with your domain instead of being fixed up front;
  promotion stays manual by default, and strict curation mode always wins.
- **Compounding confidence** — a fact's confidence **rises** as independent
  sources corroborate it and **falls** when contradicted; on single-valued
  ("functional") predicates the contradicted fact is **superseded — closed and
  weakened, never silently overwritten** — with the supersession recorded in
  the claims ledger. `brain_why` shows each fact's independent source count,
  its audited confidence trend, and any superseded history; `brain_stats`
  reports corroborated/superseded counts. Memory that gets more reliable the
  more it sees.

## Next — near-term

- **Published, reproducible benchmark** — an open memory-quality benchmark you
  can run yourself, so retrieval quality is measured, not asserted.
- **Richer relationship extraction** — better predicate accuracy and direction,
  and a recommended local model profile for higher-quality graphs.

## Later — the bigger bets


- **More ingestion sources** — first-class connectors beyond files and repos.
- **Managed cloud** — hosted, multi-tenant Myco for teams that would rather not
  operate Postgres themselves. Currently **waitlist only** at
  [mycobrain.dev](https://mycobrain.dev) — not generally available.

## Principles that won't change

- Postgres is the source of truth; the LLM is an advisor, not the database.
- Writes are deterministic, deduplicated, and traceable.
- Your data stays in plain Postgres tables you can inspect, export, and own.
- The core stays self-hostable and open source (Apache-2.0).

Have a use case or a feature you need? Open an issue — this roadmap is shaped by
what people actually build on Myco.
