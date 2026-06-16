<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/myco-logo-dark.png">
    <img src="./docs/assets/myco-logo.png" alt="Myco Brain" width="340">
  </picture>
</p>

**Self-hosted memory for AI agents that gets more trustworthy the more it sees — every fact has a source, confidence that compounds with evidence, and contradictions are superseded, never silently overwritten. On your own Postgres. Zero API keys required.**

[![CI](https://github.com/thegoodguysla/myco-brain/actions/workflows/ci.yml/badge.svg)](https://github.com/thegoodguysla/myco-brain/actions)
[![npm](https://img.shields.io/npm/v/@mycobrain/mcp-server)](https://www.npmjs.com/package/@mycobrain/mcp-server)
[![LongMemEval](https://img.shields.io/badge/LongMemEval_oracle-73.6%25_·_100%25_evidence_recall-blue)](./evals/longmemeval/README.md)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

![Watch it remember — save, ask days later, recall with provenance](./demos/media/watch-it-remember.gif)

Your agents forget everything between sessions. The usual fix — letting an LLM
maintain its own memory — slowly fills it with duplicates, hallucinated
summaries, and confident answers nobody can trace. Myco Brain is built on the
opposite contract:

> **The LLM proposes. Deterministic rules decide what becomes a fact. You set
> the bar** — from corroboration-gated auto-promotion (the default) to strict
> human review of every fact (`BRAIN_REQUIRE_HUMAN_REVIEW=1`).

Claude, Cursor, Windsurf, Continue, Zed, and custom agents share one memory
backed by your own Postgres. The write path is deterministic, every fact is
source-traceable, and the trust engine does what no markdown wiki can: facts
**earn** confidence from independent corroboration and **lose** it when
contradicted — with the full history kept, audited, and queryable.

```bash
# 1. Boot the stack (Postgres + MCP server + extraction worker)
git clone https://github.com/thegoodguysla/myco-brain.git && cd myco-brain
docker compose up -d

# 2. Give your agent a memory — point it at any repo or folder
#    (no env needed: it finds the quickstart stack on localhost)
npx -y -p @mycobrain/mcp-server mycobrain-ingest github:your-org/your-repo

# 3. Connect your client (one-liner below), then ask across sessions:
#    "what did we decide about auth, and where is that documented?"
#    → answered from your docs, with the source cited.
```

**Zero API keys, all the way down:** full-text search, semantic search (local
embeddings), and the knowledge graph (local extraction) all run with no hosted
dependency. Add an Anthropic key only if you want the most accurate graph.

Quick links:
[10-minute quickstart](#get-started-in-under-10-minutes) ·
[Teach your agent to use it well](./docs/agent-setup.md) ·
[The trust engine](#memory-that-gets-more-trustworthy-compounding-confidence) ·
[Benchmark — run it yourself](#benchmark--run-it-yourself) ·
[Run every proof](#every-claim-has-a-check) ·
[Architecture](#architecture) ·
[Roadmap](./ROADMAP.md) ·
[Cloud waitlist](#cloud-waitlist)

## Memory that gets more trustworthy (compounding confidence)

Most agent memory **overwrites** facts silently. Myco Brain **compounds** them:

![Compounding confidence — corroboration raises, contradiction supersedes](./demos/media/compounding-confidence.gif)

- An independent source agreeing with a fact **raises** its confidence
  (damped noisy-OR — ten chunks of one document corroborate nothing; only
  distinct sources count).
- A confident contradiction on a single-valued relationship (who you *work
  for*, where something *is located*) **supersedes** the old fact: it's
  closed and weakened — **kept, never deleted** — with the supersession
  recorded in an audited claims ledger.
- Ask `brain_why` about any fact and you get its independent source count, its
  confidence trend over time ("0.8 → 0.86"), and any superseded history.
  Contradictions stay visible. Your memory can't gaslight you.

```text
works for → Halcyon Labs           0.55  [SUPERSEDED — kept, not deleted]
works for → Driftwood Analytics    0.90  [ACTIVE]
claims ledger: old fact superseded_by → new fact (audited)
```

*Proof: `npm run test:compounding` — the full lifecycle runs against a live
database in seconds, no LLM required.*

## The schema evolves with your data (dynamic schema)

The extraction worker notices entity kinds and relationship types your catalog
doesn't have yet and **proposes** them (`brain_stats`: *"Brain proposed 3 new
types from your data"*). Promotion is yours by default — or opt in to
auto-promotion for types corroborated across enough independent documents,
with a full audit trail (`BRAIN_SCHEMA_AUTO_PROMOTE=1`). One chatty document
can never promote anything. *Proofs: `npm run test:dynamic-schema`,
`npm run test:schema-promotion`.*

**You pick the trust dial:**

| Mode | Behavior |
|---|---|
| Default | Confident facts auto-promote; novel types wait for review |
| `BRAIN_REQUIRE_HUMAN_REVIEW=1` | **Strict curation** — nothing the LLM proposes touches the canonical graph without a human decision |
| `BRAIN_SCHEMA_AUTO_PROMOTE=1` | Corroborated new types promote themselves, audited |

When something is waiting on you — novel types in default mode, or everything
in strict mode — review it from the command line:

```bash
mycobrain review                 # list pending entities, relationships, types
mycobrain review approve <id>    # promote it into the graph
mycobrain review reject  <id>    # reject it (kept and audited, never deleted)
```

*Proof: `npm run test:review` — approving actually lands the entity / edge /
type in the canonical graph; rejecting never does.*

## Private memories, shared knowledge

Multi-agent teams get real isolation: documents marked `private` are readable
**only by the agent that created them** — enforced in every read tool, on top
of workspace row-level security. Workspace memory stays shared. *Proof:
`npm run test:sharing` (a two-agent visibility matrix).*

### Running an agency? One isolated workspace per client.

Put each client in their own workspace, share one agency-wide playbook, and
the guarantee you sell is **Postgres row-level security** — a session scoped
to Client A physically cannot return Client B's rows. The
[agency starter kit](./examples/agency/) provisions it (one command) and ships
the least-privilege DB role that makes the isolation actually bind. *Proof:
`npm run test:agency` — Client A sees zero of Client B's facts, and it shows
why the default superuser connection must not be used for multi-tenant.*

## Query over HTTP (read-only)

Not everything speaks MCP. For a web app, an automation, or a partner backend,
`mycobrain-rest` puts a small read-only API in front of the brain — exactly two
tools, `search` and `why`, plus health:

```bash
mycobrain-rest                                  # → http://127.0.0.1:8787

curl -s localhost:8787/search \
  -H "Authorization: Bearer brain_<ws>_<agent>_<secret>" \
  -d '{"query":"what did we decide about pricing?","limit":5}'
```

The key scopes every query to its workspace (same row-level security as MCP);
there are **no write routes**. It binds to loopback by default — set
`BRAIN_REST_HOST=0.0.0.0` behind your own TLS/proxy only when you mean to
expose it, and treat the key like a password. *Proof: `npm run test:rest`.*

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

> All demos are **code, not screen recordings** — `demos/` re-renders them
> deterministically against a fresh stack (`npm run demo:render -- all`).

## Why This Architecture

|  | mem0 | LangChain Memory | Myco Brain |
|---|---|---|---|
| Fact extraction | LLM-based | LLM-based | Deterministic write path; LLM output enters only via gated proposal queues |
| Contradicting facts | Coexist as independent records | Possible | **Superseded, never overwritten** — audited claims ledger |
| Fact confidence | Static | — | **Compounds with independent evidence**, falls on contradiction |
| Hallucinated facts | Possible | Possible | Constrained out of the write path |
| Provenance | Partial | Partial | First-class via `brain_why` (source + audit trail + confidence trend) |
| Shared memory | Depends on app wiring | Depends on app wiring | Native Postgres source of truth, multi-agent with per-object privacy |
| Benchmark | Self-reported | — | **Harness ships in-repo** — reproduce the number yourself |
| Data portability | Vendor / framework shaped | Framework shaped | Plain Postgres tables |

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

No API keys required to boot. BM25 search works immediately. For **semantic
search**, run local embeddings with Ollama (`BRAIN_EMBED_PROVIDER=ollama`) or
set `BRAIN_OPENAI_API_KEY`. For the **knowledge graph**, use
[Ollama locally](#build-the-knowledge-graph--locally-no-api-keys) (no key) or
`BRAIN_ANTHROPIC_API_KEY`.

Confirm it's healthy in one command (and see which optional features are on):

```bash
npx -y -p @mycobrain/mcp-server mycobrain-doctor
```

### Connect your client

**Claude Code** — one command (uses the quickstart stack's seeded, public
localdev credentials):

```bash
claude mcp add myco-brain \
  --env DATABASE_URL=postgresql://brain:brain@localhost:5432/brain \
  --env BRAIN_API_KEY=brain_00000000-0000-0000-0000-000000000001_00000000-0000-0000-0000-0000000000a1_localdev \
  -- npx -y @mycobrain/mcp-server
```

Restart Claude Code and the `brain_*` tools are live — the server hands every
connected agent its usage contract automatically (when to recall, save, and
cite), so it works well out of the box.

**Claude Desktop** — add this to
`~/Library/Application Support/Claude/claude_desktop_config.json`
(**Cursor** and **Windsurf** take the same `mcpServers` block in
`.cursor/mcp.json` / their MCP settings):

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

### First run — the fastest path to *your* magic moment

Myco ships **empty**. The "whoa" lands hardest on your *own* data, so the
recommended first step is to bring your history in:

```bash
# Guided getting-started — leads with importing your own history
npx -y -p @mycobrain/mcp-server mycobrain-onboard
```

```bash
# Import your ChatGPT or Claude export (~30s), then ask your agent about your past
mycobrain-ingest --from chatgpt-export ~/Downloads/<your-export>.zip
mycobrain-ingest --from claude-export  ~/Downloads/<your-export>.zip
#   → "what did I decide about <topic>?" answered from your own conversations.
```

Prefer to skip it? Just start using it — Brain remembers as you work. Or take a
**60-second live tour** on sample data that cleans up after itself (your
workspace is left untouched):

```bash
mycobrain-onboard --tour
```

### See it work with the demo corpus (optional sandbox)

Want a richer guided example? Load the included demo corpus — a small set of
interconnected documents for a fictional agency and its client:

```bash
npx -y -p @mycobrain/mcp-server mycobrain-ingest ./examples/demo-corpus
```

Then ask any connected agent:

- *"When does Northwind's rebrand launch, and who owns the account?"*
- *"What pricing model did we choose for Northwind, and why?"*
- *"Show me the source for that."* — provenance via `brain_why`
- *"Show my Myco memory stats."* — health snapshot via `brain_stats`

Every answer traces back to the document it came from. No API key required.

**The finale:** the corpus contains a deliberate contradiction — one document
says Devin Osei works for Lumen, a later one says he left for Harbor & Co.
With the [keyless local graph](#build-the-knowledge-graph--locally-no-api-keys)
running, ask:

- *"Who does Devin Osei work for? What changed, and how do you know?"*

The old fact comes back **superseded — kept, not deleted** — with both source
documents cited. That's the trust engine working on your data, not a demo
script.

Done exploring? Clear *only* the bundled sample data (your own imports and
memories are never touched) with:

```bash
mycobrain-onboard --reset-demo
```

## Bulk-ingest a folder or repo

Point Brain at a directory or a GitHub repo and it indexes every text file —
searchable across sessions, with each answer traceable to its source file.

```bash
npx -y -p @mycobrain/mcp-server mycobrain-ingest ./docs        # a local folder
npx -y -p @mycobrain/mcp-server mycobrain-ingest github:owner/repo   # a GitHub repo
```

No env needed against the quickstart stack — the CLI defaults to it. For your
own Postgres or workspace, set the same env vars the MCP server uses
(`DATABASE_URL`, `BRAIN_WORKSPACE_ID`, `BRAIN_API_KEY`).

Then ask any connected agent: *"search my ingested files for the auth flow"* or
*"show my Myco memory stats"*. Set `GITHUB_TOKEN` for private repos.

## Build the knowledge graph — locally, no API keys

What separates Myco from a vector store is the **graph**. The extraction worker
reads your ingested documents and:

- pulls out the **entities** — people, companies, projects, places;
- **collapses duplicates** so "Priya" and "Priya Raman" become one node;
- connects them with **directed relationships** — *Mara Quinn —works for→
  Northwind Coffee*, never the reverse (the shipped prompt is
  direction-aware: measured **86% directed accuracy** with `llama3.2:3b`, up
  from 79% — and relation endpoints the model forgets to list are recovered
  automatically, lifting graph edge survival from **0% to 86%** on the gold
  fixture; *proof: `npm run test:direction`*);
- and **proposes new types** it observes, so the schema grows with your domain.

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

### Option B — Most accurate (Anthropic, bring your key)

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

## Benchmark — run it yourself

Myco Brain scores **73.6% end-to-end QA accuracy on the complete 500-question
[LongMemEval](https://github.com/xiaowu0162/LongMemEval) `oracle` subset** (no
sampling) with **100% evidence-retrieval recall** — reader `gpt-4o-mini`, judge
`gpt-4o`. We also publish the **strong-reader config side by side** (gpt-4o
reader: 71.8% — yes, *lower*; with retrieval at 100% evidence recall the
reader isn't the bottleneck, which is exactly why single-headline comparisons
across systems are meaningless). The harness ships in this repo, so the
numbers are reproducible, not asserted:

```bash
cd evals/longmemeval && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && cd ../..
OPENAI_API_KEY=sk-... DATABASE_URL=postgresql://brain:brain@localhost:5432/brain \
  evals/longmemeval/.venv/bin/python3 -m evals.longmemeval.run \
  --examples 500 --subset longmemeval_oracle --judge-model gpt-4o
```

Methodology, both configs, per-category breakdown (including the categories
that are hard for us — reported, not hidden), and cheaper sample commands:
[evals/longmemeval/README.md](evals/longmemeval/README.md).

## Every claim has a check

Nothing on this page asks for your trust — each capability names the runnable
proof that gates it in development:

| Claim | Check |
|---|---|
| Quickstart works end-to-end | `node test/quickstart-e2e.mjs` (also runs in CI against the real Docker stack) |
| Duplicates can't happen; provenance is total | `node examples/benchmark/run.mjs` |
| Keyless semantic search finds meaning, not words | `npm run test:local-embeddings` |
| Relationships are direction-aware; edges survive | `npm run test:direction` |
| Confidence rises with evidence, contradiction supersedes | `npm run test:compounding` |
| New types are proposed (and auto-promote only when corroborated + opted-in) | `npm run test:dynamic-schema` · `npm run test:schema-promotion` |
| Strict curation mode blocks all auto-promotion | `npm run test:strict-mode` |
| Private documents are private | `npm run test:sharing` |
| All 11 tools fit in your context (~1.9K tokens, not bloat) | `npm run audit:tokens` |
| Agency: Client A can't read Client B (workspace RLS) | `npm run test:agency` |
| Reviewing a proposal actually promotes/rejects it | `npm run test:review` |
| Read-only REST API: auth, read-only, DoS-capped | `npm run test:rest` |
| The benchmark number | `evals/longmemeval/` (full harness in-repo) |

## Architecture

```mermaid
flowchart TB
    clients["MCP clients<br/>Claude · Cursor · Windsurf · Continue · Zed · custom"]
    tools["11 MCP tools<br/>context_pack · search · why · neighbors · ingest · save/recall_memory · stats …"]
    write["Deterministic write path<br/>content-hash dedup · chunking · idempotency keys · field-level audit (vc)"]
    pg[("Postgres — the source of truth<br/>documents · entities · directed relations · claims ledger<br/>evidence · schema proposals · provenance · vectors")]
    trust["Trust engine<br/>confidence compounds with independent evidence<br/>contradictions supersede (never overwrite)"]
    llm["LLM advisory layer (optional, local-first)<br/>Ollama or Anthropic extraction · Ollama or OpenAI embeddings<br/>everything enters via gated proposal queues"]

    clients --> tools --> write --> pg
    llm -. proposes only .-> write
    pg <--> trust
```

The design is simple on purpose: **the database is authoritative, the write
path is programmatic, and LLMs assist without becoming the memory store.** The
lineage is the Hyperscope/Engelbart tradition of deterministic knowledge
repositories — applied to agents.

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
├── supabase/migrations/     # versioned SQL migrations
├── demos/                   # demos-as-code (VHS + ffmpeg + narration pipeline)
├── docs/quickstart.md       # setup guide
├── evals/
│   └── longmemeval/         # LongMemEval benchmark harness (run it yourself)
├── examples/
│   ├── demo-corpus/         # sample interconnected docs to ingest
│   └── benchmark/           # reproducible dedup + provenance benchmark
├── docker-compose.yml       # local quickstart
├── ROADMAP.md               # where this is headed
└── LICENSE                  # Apache-2.0
```

## Import your ChatGPT / Claude history

Months of assistant conversations become provenance-tracked, deduplicated,
searchable memory — one document per conversation:

```bash
# Official OpenAI data export (zip, extracted folder, or conversations.json)
mycobrain-ingest --from chatgpt-export ./chatgpt-export.zip

# claude.ai data export
mycobrain-ingest --from claude-export ./claude-export.zip
```

Re-importing the same export never duplicates — each conversation becomes one
content-hash-keyed document, so a re-run is a no-op (continue a conversation
and re-export, and the longer transcript imports as a new version alongside
the old). ChatGPT's branched conversations import the ACTIVE branch (the
transcript you actually kept, not rejected regenerations), and `brain_why`
traces every imported fact back to its export file.
*Proof: `npm run test:export-import`.*

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
