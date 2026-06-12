# Myco Brain

**A self-hosted memory layer for AI agents that gives any MCP client cross-session recall with deterministic facts and source-backed answers.**

[![CI](https://github.com/thegoodguysla/myco-brain/actions/workflows/ci.yml/badge.svg)](https://github.com/thegoodguysla/myco-brain/actions)
[![npm](https://img.shields.io/npm/v/@mycobrain/mcp-server)](https://www.npmjs.com/package/@mycobrain/mcp-server)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

Myco Brain gives Claude, Cursor, Windsurf, Continue, Zed, and custom agents one shared memory backed by your own Postgres. The write path is deterministic, provenance is queryable, and LLMs stay advisory instead of becoming your database.

```bash
# 1. Boot the stack (Postgres + MCP server + extraction worker)
git clone https://github.com/thegoodguysla/myco-brain.git && cd myco-brain
docker compose up -d

# 2. Give your agent a memory of your codebase — point it at any repo or folder
npx -y -p @mycobrain/mcp-server mycobrain-ingest github:your-org/your-repo

# 3. Connect Claude/Cursor/etc. (see below), then ask across sessions:
#    "what did we decide about auth, and where is that documented?"
#    → answered from your ingested docs, with the source file cited.
```

No API keys required to start. Search and ingestion work immediately; add a
local model ([Ollama](#build-the-knowledge-graph--locally-no-api-keys)) or
Anthropic to build the knowledge graph.

Most agent-memory systems quietly fill with noise — duplicate facts, hallucinated summaries, and answers no one can trace. Myco Brain is built so that can't happen: duplicate writes are rejected by content hash ([reproducible benchmark](./examples/benchmark)), accepted facts link back to their source, and you can always ask **what** your agent knows, **why** it knows it, and **where** it came from.

Quick links:

- [Get started in under 10 minutes](#get-started-in-under-10-minutes)
- [Five verified demos](#five-verified-demos)
- [Build the knowledge graph (no API keys)](#build-the-knowledge-graph--locally-no-api-keys)
- [Roadmap](./ROADMAP.md)
- [Architecture](#architecture)
- [Cloud waitlist](#cloud-waitlist)

## Five Verified Demos

### 1. Cross-session recall

Save a fact in one conversation:

```text
Save a memory: the board meeting is every Wednesday at 9 AM Pacific.
```

Start a fresh conversation and ask:

```text
What time is the board meeting?
```

Expected result: the new session retrieves the stored fact instead of relying on chat history.

### 2. Cross-agent shared memory

Write from one client:

```text
Save a memory: Acme's renewal call is on October 15 with Jordan.
```

Read from another client:

```text
What is Acme's renewal date?
```

Expected result: both clients read the same shared memory because the source of truth is Postgres, not a single chat thread.

### 3. Provenance for answers

Ask `brain_why` about any fact and get the source chain — not a trust-me summary.
Real output for an entity built from the demo corpus:

```json
{
  "subject": { "kind": "entity", "name": "Mara Quinn" },
  "evidence": {
    "mention_count": 4,
    "source_document_count": 4,
    "summary": "Supported by 4 mentions across 4 source documents."
  },
  "source_proposals": [
    { "extracted_by": "ollama:llama3.2:3b", "confidence": 1, "state": "auto_promoted",
      "source_hyobject_id": "8e31414c-…" }
  ]
}
```

Every accepted fact traces to the document(s) it came from and how it was extracted.

### 4. Document ingestion with sources

Ingest a file or URL:

```text
Ingest ./docs/customer-handbook.pdf and summarize the onboarding checklist with sources.
```

Expected result: the document is chunked, indexed, and cited back through retrieval.

### 5. Graph relationships

Ask:

```text
Show related entities for Acme and explain how they connect.
```

Expected result: relationship queries surface connected people, documents, and entities — and the **entity-to-entity edges** the extraction worker builds (e.g. *Mara Quinn —manages→ Northwind Coffee*) — instead of flat vector matches. Build this graph [locally with Ollama](#build-the-knowledge-graph--locally-no-api-keys), no API key required.

## Why This Architecture

|  | mem0 | LangChain Memory | Myco Brain |
|---|---|---|---|
| Fact extraction | LLM-based | LLM-based | Deterministic write path |
| Hallucinated facts | Possible | Possible | Constrained out of the write path |
| Provenance | Partial | Partial | First-class via `brain_why` |
| Shared memory | Depends on app wiring | Depends on app wiring | Native Postgres source of truth |
| Data portability | Vendor / framework shaped | Framework shaped | Plain Postgres tables |
| Cross-session recall | Best effort | Best effort | Built into the product |

## Get Started In Under 10 Minutes

Verified local path: Docker Compose from a fresh clone.

```bash
git clone https://github.com/thegoodguysla/myco-brain.git
cd myco-brain
docker compose up -d
```

What starts:

- Postgres 16 + pgvector
- MCP server
- Extraction worker

No API keys required to boot. BM25 search works immediately. Add `BRAIN_OPENAI_API_KEY` later for vector search, and build the knowledge graph either **locally with [Ollama](#build-the-knowledge-graph--locally-no-api-keys)** (no API key) or with `BRAIN_ANTHROPIC_API_KEY`.

### Connect Claude Desktop

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "myco-brain": {
      "command": "npx",
      "args": ["-y", "@mycobrain/mcp-server"],
      "env": {
        "DATABASE_URL": "postgresql://brain:brain@localhost:5432/brain",
        "BRAIN_WORKSPACE_ID": "00000000-0000-0000-0000-000000000001",
        "BRAIN_API_KEY": "brain_00000000-0000-0000-0000-000000000001_00000000-0000-0000-0000-0000000000a1_localdev"
      }
    }
  }
}
```

Then test the happy path:

```text
Save a memory: the launch checklist lives in the ops folder.
```

Open a new session and ask:

```text
Where does the launch checklist live?
```

Full setup guide: [docs/quickstart.md](./docs/quickstart.md)

### See it work in 30 seconds (with demo data)

Don't want to ingest your own files yet? Load the included demo corpus — a small
set of interconnected documents for a fictional agency and its client:

```bash
npx -y -p @mycobrain/mcp-server mycobrain-ingest ./examples/demo-corpus
```

Then ask any connected agent:

- *"When does Northwind's rebrand launch, and who owns the account?"*
- *"What pricing model did we choose for Northwind, and why?"*
- *"Show me the source for that."* — provenance via `brain_why`
- *"Show my Myco memory stats."* — health snapshot via `brain_stats`

Every answer traces back to the document it came from. No API key required.

## Bulk-ingest a folder or repo

Point Brain at a directory or a GitHub repo and it indexes every text file —
searchable across sessions, with each answer traceable to its source file. No
API key required (full-text search works immediately; for semantic search, run
local embeddings with Ollama — `BRAIN_EMBED_PROVIDER=ollama` — or set an OpenAI
key).

```bash
# Connection comes from the same env vars the MCP server uses
export DATABASE_URL=postgresql://brain:brain@localhost:5432/brain
export BRAIN_WORKSPACE_ID=00000000-0000-0000-0000-000000000001
export BRAIN_API_KEY=brain_00000000-0000-0000-0000-000000000001_00000000-0000-0000-0000-0000000000a1_localdev

npx -y -p @mycobrain/mcp-server mycobrain-ingest ./docs        # a local folder
npx -y -p @mycobrain/mcp-server mycobrain-ingest github:owner/repo   # a GitHub repo
```

Then ask any connected agent: *"search my ingested files for the auth flow"* or
*"show my Myco memory stats"*. Set `GITHUB_TOKEN` for private repos.

## Build the knowledge graph — locally, no API keys

What separates Myco from a vector store is the **graph**. The extraction worker
reads your ingested documents and:

- pulls out the **entities** — people, companies, projects, places;
- **collapses duplicates** so "Priya" and "Priya Raman" become one node; and
- connects them with **relationships** — e.g. *Mara Quinn —manages→ Northwind
  Coffee* — so you can traverse how facts relate, not just match similar text.

You choose which model does the extraction. **Nothing leaves your machine with
Ollama; Anthropic produces the most accurate graph.**

### Option A — Local & free (Ollama, no API key)

```bash
# Install Ollama (https://ollama.com/download), then pull a model:
ollama pull llama3.2:3b

# Point the worker at it and restart:
echo "BRAIN_OLLAMA_BASE_URL=http://host.docker.internal:11434" >> .env
docker compose up -d
```

> **Accuracy note.** Small local models (e.g. `llama3.2:3b`) extract entities
> well but sometimes get relationship *direction* wrong — they may record
> *Northwind —employs→ Mara* instead of *Mara —works for→ Northwind*. A larger
> local model improves this (`ollama pull llama3.1:8b`, then set
> `BRAIN_OLLAMA_MODEL=llama3.1:8b`); Anthropic (Option B) is the most accurate.

### Option B — Most accurate (Anthropic, bring your key)

For the cleanest relationships, point the worker at Claude — one line:

```bash
echo "BRAIN_ANTHROPIC_API_KEY=sk-ant-..." >> .env
docker compose up -d
```

If both are configured, Anthropic is used automatically (it's more accurate);
force a choice with `BRAIN_EXTRACTION_PROVIDER=ollama|anthropic`.

### Try it

Ingest a few documents, give the worker a moment, then ask a connected agent:

- *"What entities are in my Northwind documents?"* — `brain_neighbors`
- *"How does Mara Quinn connect to Northwind?"* — entity-to-entity relationships
- *"Show my Myco memory stats."* — watch the graph grow (`brain_stats`)

Either way, the canonical graph lives in your Postgres — the model only
*proposes*; the database decides what becomes a durable fact.

## Architecture

```text
                    ┌──────────────────────────────┐
                    │ MCP clients                  │
                    │ Claude · Cursor · Continue   │
                    │ Windsurf · Zed · custom      │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │ MCP tools                    │
                    │ search · ingest · why        │
                    │ neighbors · get_related      │
                    │ save_memory · recall_memory  │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │ Deterministic write path     │
                    │ chunking · hashing · schema  │
                    │ validation · audit trail     │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │ Postgres source of truth     │
                    │ facts · claims · chunks      │
                    │ vectors · provenance graph   │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │ LLM advisory layer           │
                    │ embeddings · extraction      │
                    │ descriptions · suggestions   │
                    └──────────────────────────────┘
```

The system design is simple on purpose: the database is authoritative, the write path is programmatic, and LLMs assist without becoming the memory store.

## Tool Surface

Myco Brain exposes 11 MCP tools:

- `brain_context_pack`
- `brain_search`
- `brain_why`
- `brain_neighbors`
- `brain_ingest`
- `brain_propose_fact`
- `brain_annotate`
- `brain_save_memory`
- `brain_recall_memory`
- `brain_get_related`
- `brain_stats`

Full inputs, outputs, and examples for each tool: **[docs/api-reference.md](./docs/api-reference.md)**.

## Repository Layout

```text
myco-brain/
├── mcp-server/              # TypeScript MCP server + bulk-ingest CLI
├── supabase/migrations/     # 42 versioned SQL migrations
├── docs/quickstart.md       # setup guide
├── evals/
│   └── longmemeval/         # LongMemEval benchmark harness (run it yourself)
├── examples/
│   ├── demo-corpus/         # sample interconnected docs to ingest
│   └── benchmark/           # reproducible dedup + provenance benchmark
├── docker-compose.yml       # local quickstart
├── ROADMAP.md               # where this is headed
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md
├── NOTICE
└── LICENSE                  # Apache-2.0
```

## Benchmark — run it yourself

Myco Brain scores **73.6% end-to-end QA accuracy on the complete 500-question
[LongMemEval](https://github.com/xiaowu0162/LongMemEval) `oracle` subset** (no
sampling) with **100% evidence-retrieval recall** — reader `gpt-4o-mini`, judge
`gpt-4o`. The harness ships in this repo, so the number is reproducible, not
asserted:

```bash
cd evals/longmemeval && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && cd ../..
OPENAI_API_KEY=sk-... DATABASE_URL=postgresql://brain:brain@localhost:5432/brain \
  evals/longmemeval/.venv/bin/python3 -m evals.longmemeval.run \
  --examples 500 --subset longmemeval_oracle --judge-model gpt-4o
```

Methodology, per-category breakdown, and cheaper sample commands:
[evals/longmemeval/README.md](evals/longmemeval/README.md).

## Cloud Waitlist

Self-hosting is the default. If you want managed hosting instead, join the waitlist:

**[mycobrain.dev](https://mycobrain.dev)**

That page is the canonical waitlist entrypoint. This README intentionally does not embed a form.

## OSS Files

- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
- [SECURITY.md](./SECURITY.md)
- [NOTICE](./NOTICE)
- [LICENSE](./LICENSE)

## Resources

- [Quickstart](./docs/quickstart.md)
- [npm package](https://www.npmjs.com/package/@mycobrain/mcp-server)
- [Issue tracker](https://github.com/thegoodguysla/myco-brain/issues)
- [Cloud waitlist](https://mycobrain.dev)

## Who built this

Myco Brain was built by **Nick Taylor** — a growth marketer, not a career engineer — directing a team of AI coding agents. Roughly three months and about $6k in model spend, built with AI-assisted engineering. The point isn't the price tag; it's that a clear product vision plus modern agent tooling can now ship production-grade infrastructure — and this repo is the result, tested end-to-end in CI so you can judge it yourself.

**Like this?** A ⭐ helps others find it, and *Watch → Releases* (top of the page) will ping you when new capabilities ship — see the [roadmap](./ROADMAP.md) for what's next.

**Want this for your team?** If your company wants someone who can build agent systems, automation, and growth engineering like this, that's what **The Good Guys** does — email [nick@thegoodguys.la](mailto:nick@thegoodguys.la) or [book a call](https://calendar.app.google/B6pSrRvv3FWX9C4u8).
