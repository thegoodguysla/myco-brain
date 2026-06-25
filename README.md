<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/myco-logo-dark.png">
    <img src="./docs/assets/myco-logo.png" alt="Myco Brain" width="340">
  </picture>
</p>

**Persistent, source-traceable memory for AI agents — self-hosted on your own Postgres, with no API keys required to run.**

[![CI](https://github.com/thegoodguysla/myco-brain/actions/workflows/ci.yml/badge.svg)](https://github.com/thegoodguysla/myco-brain/actions)
[![npm](https://img.shields.io/npm/v/@mycobrain/mcp-server)](https://www.npmjs.com/package/@mycobrain/mcp-server)
[![LongMemEval](https://img.shields.io/badge/LongMemEval-73.6%25_QA_·_recall@5_89--92%25-blue)](./evals/longmemeval/README.md)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

![Watch it remember — save, ask days later, recall with provenance](./demos/media/watch-it-remember.gif)

- **Source-traceable.** Every fact traces to the document it came from (`brain_why`) — no trust-me summaries.
- **Trust that compounds.** Independent corroboration _raises_ a fact's confidence; a contradiction _supersedes_ it — kept and audited, never silently overwritten.
- **Keyless & local-first.** Full-text + semantic search and the knowledge graph all run with zero hosted dependency — add an Anthropic key only for the most accurate graph.
- **Yours.** Apache-2.0, plain Postgres tables, 13 MCP tools. Works with Claude, Cursor, Windsurf, Continue, Zed.

**Who it's for:** **dev teams** running agents that need one shared memory · **agencies** needing hard per-client isolation · **anyone** who wants their assistant to remember across sessions — import your ChatGPT / Claude history (from your data export) and your AI knows you on day one.

_Built solo by a growth marketer — not a career engineer — directing AI coding agents over ~3 months. [How it was built ↓](#who-built-this)_

The usual fix for agent amnesia — letting an LLM maintain its own memory —
fills it with duplicates, hallucinated summaries, and confident answers nobody
can trace. Myco Brain is built on the opposite contract:

> **The LLM proposes. Deterministic rules decide what becomes a fact. You set
> the bar** — from corroboration-gated auto-promotion (the default) to strict
> human review of every fact (`BRAIN_REQUIRE_HUMAN_REVIEW=1`).

Claude, Cursor, Windsurf, Continue, Zed, and custom agents all share one memory
backed by your own Postgres.

⭐ If the trust model resonates, a star helps others find it.

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

> [!TIP]
> **Zero API keys, all the way down.** Full-text search, semantic search (local
> embeddings), and the knowledge graph (local extraction) all run with no hosted
> dependency. Add an Anthropic key only if you want the most accurate graph.

**MCP-native by design — your agent knows _when_ to use memory, not just _how_.**
Most MCP servers expose tools and hope the model calls them. Myco ships a usage
contract over MCP's `instructions` channel: the moment it connects, your agent
knows to pull context before a task, save durable decisions, and cite sources
with `brain_why` — no per-project prompting. Tune the policy in one copy-paste
block: [Teach your agent to use it well](./docs/agent-setup.md).

Quick links:
[10-minute quickstart](#get-started-in-under-10-minutes) ·
[Teach your agent to use it well](./docs/agent-setup.md) ·
[The trust engine](#memory-that-gets-more-trustworthy-compounding-confidence) ·
[Benchmark — run it yourself](#benchmark--run-it-yourself) ·
[Run every proof](#every-claim-has-a-check) ·
[Who it's for](#who-its-for) ·
[Environment variables](#environment-variables) ·
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
- Ask `brain_why` about any fact and you get its **distinct** source count (per
  relationship, not per mention), its confidence trend over time ("0.8 → 0.86"),
  and any superseded history.
  Contradictions stay visible. Your memory can't gaslight you.

```text
works for → Halcyon Labs           0.55  [SUPERSEDED — kept, not deleted]
works for → Driftwood Analytics    0.90  [ACTIVE]
claims ledger: old fact superseded_by → new fact (audited)
```

*Proof: `npm run test:compounding` — the full lifecycle runs against a live
database in seconds, no LLM required.*

## The schema evolves with your data (dynamic schema)

- The extraction worker notices entity kinds and relationship types your catalog
  doesn't have yet and **proposes** them (`brain_stats`: *"Brain proposed 3 new
  types from your data"*).
- **Promotion is yours by default** — or opt into auto-promotion for types
  corroborated across enough **distinct source documents**
  (`BRAIN_SCHEMA_AUTO_PROMOTE=1`), counted per document, not per mention, so two
  documents passed back and forth can't manufacture consensus. One chatty
  document can never promote anything.
- A promoted type stays **scoped to the workspace that earned it** — one client's
  vocabulary never leaks into another's catalog (see
  [per-client isolation](#one-isolated-workspace-per-client--built-for-agencies)).

*Proofs: `npm run test:dynamic-schema`, `npm run test:schema-promotion`.*

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
`npm run test:sharing` (a two-agent visibility matrix).* Like workspace
isolation, it binds only under the least-privilege `brain_app` role
([security note](#one-isolated-workspace-per-client--built-for-agencies)).

## One isolated workspace per client — built for agencies

Put each client in their own workspace, share one agency-wide playbook, and
the guarantee you sell is **Postgres row-level security** — a session scoped
to Client A cannot return Client B's rows. The
[agency starter kit](./examples/agency/) provisions it (one command) and ships
the least-privilege DB role that makes the isolation actually bind. *Proof:
`npm run test:agency` — Client A sees zero of Client B's facts.*

> [!IMPORTANT]
> **Isolation binds only under the least-privilege role.** RLS does not constrain
> a Postgres **superuser**, and the zero-config quickstart's default `brain` role
> *is* a superuser (fine for a single-workspace self-host — there's nothing to
> isolate). Before you put more than one client in one database, run the app as
> the `NOSUPERUSER` `brain_app` role the agency kit ships; `mycobrain-doctor`
> flags a superuser connection. Multi-tenant isolation is a guarantee of
> `brain_app`, not of the default quickstart role.

<details>
<summary><strong>Advanced — multi-tenant gateways: who is the caller? (<code>BRAIN_TRUST_REQUEST_IDENTITY</code>)</strong></summary>

<br>

RLS decides *which rows a tenant can read*; this setting decides *which tenant a
request is* — the step before RLS. On the **stdio** server, identity is taken
**only from the server's environment** by default: a `workspace_id`, `agent_id`,
or `api_key` supplied in tool-call arguments is **ignored**, so even a
prompt-injected agent can't pass `workspace_id: "<someone-else>"` to reach
another workspace. (For `brain_` keys, identity comes from the key string and
nothing else.)

Set `BRAIN_TRUST_REQUEST_IDENTITY=1` **only** when you front the server with a
real multi-tenant gateway that authenticates each request and maps it to a
tenant itself — then per-request identity is honored (and a service-role JWT
must **equal** `BRAIN_SERVICE_ROLE_KEY`, not merely look like one). **Single-tenant
self-hosts need none of this** — their identity is already environment-derived.

</details>

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

- **Scoping:** the key scopes every query to its workspace (same RLS as MCP), and
  there are **no write routes**. Like MCP, this binds only under the least-privilege
  `brain_app` role ([security note](#one-isolated-workspace-per-client--built-for-agencies)) —
  never expose REST as the default `brain` superuser (`mycobrain-doctor` flags it).
- **Key verification:** installs migrated to `…_agent_api_key_verification.sql`
  verify each key's `<secret>` against `agent_api_keys` once a secret is registered
  (register/rotate via `brain_set_agent_api_key_secret(...)`). Until then the key
  acts as a bearer token; set `BRAIN_REQUIRE_API_KEY_SECRET=1` to require a
  registered secret before exposing REST.
- **Binding:** loopback by default — set `BRAIN_REST_HOST=0.0.0.0` behind your own
  TLS/proxy only when you mean to expose it, and treat the key like a password.

*Proof: `npm run test:rest`.*

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

## How Myco compares

Different tools make different tradeoffs; this compares architectural
**approaches**, not benchmarked head-to-heads — when retrieval recall is high
the answer model becomes the bottleneck, so cross-system score comparisons
mislead (see [the benchmark section](#benchmark--run-it-yourself)).

|  | Typical LLM-maintained memory | Framework memory (e.g. LangChain) | Myco Brain |
|---|---|---|---|
| Reproducible benchmark | Self-reported | — | **Harness ships in-repo** — reproduce the number yourself |
| Fact extraction | LLM-based | LLM-based | Deterministic write path; LLM output enters only via gated proposal queues |
| Contradicting facts | Coexist as independent records | Possible | **Superseded, never overwritten** — audited claims ledger |
| Fact confidence | Static | — | **Compounds with independent evidence**, falls on contradiction |
| Hallucinated facts | Possible | Possible | Constrained out of the write path |
| Provenance | Partial | Partial | First-class via `brain_why` (source + audit trail + confidence trend) |
| Shared memory | Depends on app wiring | Depends on app wiring | Native Postgres source of truth, multi-agent with per-object privacy |
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

No API keys required to boot — here's what each capability needs:

| Capability | Out of the box? | To enable |
|---|---|---|
| Full-text (BM25) search | ✅ immediately | nothing |
| Semantic search | needs embeddings | `BRAIN_EMBED_PROVIDER=ollama` (local, keyless) |
| Knowledge graph | needs an extractor | [Ollama locally](#build-the-knowledge-graph--locally-no-api-keys) (keyless) or `BRAIN_ANTHROPIC_API_KEY` (most accurate) |

Confirm it's healthy in one command. `mycobrain-doctor` doesn't just check that
env vars are set — for the local Ollama path it **live-verifies** the setup (pings
Ollama, confirms the embed/extraction models are pulled, and runs a real embed +
generation), then checks the extraction backlog and review queue. It exits
non-zero only on a real failure (a red line), so green means it works:

```bash
npx -y -p @mycobrain/mcp-server mycobrain-doctor
```

Add `--fix` to have it offer to pull any missing Ollama models for you:

```bash
npx -y -p @mycobrain/mcp-server mycobrain-doctor --fix
```

### Connect your client

**Recommended — guided setup.** One command walks you through connecting an
agent, with consent at every step:

```bash
npx -y -p @mycobrain/mcp-server mycobrain-setup
```

It runs pre-flight checks (each with an offered fix), verifies pgvector and a
real write to your database, wires up your MCP client (Claude Code, Claude
Desktop, Cursor, Codex, Windsurf), and offers a one-tap import of your ChatGPT
or Claude data export if the zip is already in `~/Downloads`. Each connected
client gets its own agent identity, so later recalls show which tool a memory
came from. Prefer to drive it yourself? The manual paths are below.

**Claude Code** — by hand (uses the quickstart stack's seeded, public localdev
credentials):

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

> **Note:** `BRAIN_WORKSPACE_ID` is derived from your `brain_` API key, so it is
> optional — the Claude Code one-liner above omits it and works the same.

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
  Northwind Coffee*, never the reverse (the shipped prompt is direction-aware,
  and endpoints the model forgets to list are recovered automatically);
- and **proposes new types** it observes, so the schema grows with your domain.

You choose which model does the extraction. **Nothing leaves your machine with
Ollama; Anthropic produces the most accurate graph.**

Two distinct, often-conflated quality measures on the 14-edge gold fixture
(*proof: `npm run test:direction`*):

| Metric | What it measures | Score |
|---|---|---|
| **Directed accuracy** | edges point the right way | **86%** (12/14, `llama3.2:3b`) |
| **Edge survival** | endpoints recovered, not dropped | **~80%** (11–12/14, gated ≥75%) |

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

The point here is **reproducibility, not a single score** — the
[LongMemEval](https://github.com/xiaowu0162/LongMemEval) harness ships in this
repo, so you run the numbers yourself; we don't assert them.

| Metric | Subset (500q) | Config | Score |
|---|---|---|---|
| End-to-end QA | `oracle` | reader gpt-4o-mini · judge gpt-4o | **73.6%** |
| End-to-end QA | `oracle` | strong reader (gpt-4o) | 71.8% |
| Evidence recall@5 (`Ev@5`) | `longmemeval_s` | hybrid (vector + BM25) | **89.2%** |
| Evidence recall@5 (`Ev@5`) | `longmemeval_s` | keyless recency reranker | **91.6%** |
| Evidence recall@10 | `longmemeval_s` | hybrid → recency | 90.2% → 93.2% |

**End-to-end QA** uses the `oracle` subset, which hands the reader only the gold
evidence sessions — so it isolates *reasoning*, not retrieval (that's `Ev@5`,
below). The strong-reader config scores *lower* (gpt-4o, 71.8%): with the evidence
already in context the memory layer is saturated, so the reader isn't the binding
constraint — exactly why single-headline comparisons across systems mislead.
Numbers others quote in the ~90% range are typically a different subset, reader,
and judge; we're not claiming a head-to-head win, just handing you the harness to
score any system on the same footing.

```bash
cd evals/longmemeval && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && cd ../..
OPENAI_API_KEY=sk-... DATABASE_URL=postgresql://brain:brain@localhost:5432/brain \
  evals/longmemeval/.venv/bin/python3 -m evals.longmemeval.run \
  --examples 500 --subset longmemeval_oracle --judge-model gpt-4o
```

**Retrieval quality** (`Ev@5` in the table) is the real retrieval metric — the
`oracle` subset above doesn't test it — measured on the full `longmemeval_s`
subset *with distractors*. The **recency reranker** (`brain_search(reranker:
'recency')`) is deterministic: no API key, no network call. Hybrid retrieval needs
an embedding provider (keyless via local Ollama, or OpenAI); stock BM25-only
search scores lower. Reproduce (embeddings only, no judge):
`python -m evals.longmemeval.run --subset longmemeval_s -n 500 --no-qa`.

Methodology, both configs, per-category breakdown (including the categories
that are hard for us — reported, not hidden), and cheaper sample commands:
[evals/longmemeval/README.md](evals/longmemeval/README.md).

## Every claim has a check

Nothing on this page asks for your trust — each capability names the runnable
proof that gates it in development. (Run the `npm run` and `node test/` checks
from `mcp-server/` after `npm install`; `node examples/` and `evals/` paths are
relative to the repo root.)

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
| All 13 tools fit in your context (~2.5K tokens, not bloat) | `npm run audit:tokens` |
| Agency: Client A can't read Client B (workspace RLS) | `npm run test:agency` |
| Reviewing a proposal actually promotes/rejects it | `npm run test:review` |
| Read-only REST API: auth, read-only, DoS-capped | `npm run test:rest` |
| The benchmark number | `evals/longmemeval/` (full harness in-repo) |

## Who it's for

Myco is the memory layer for any team whose AI agents need to remember, with
receipts. Each page below reframes it for your audience and walks the same use
cases across industries (FinTech, Healthcare, Legal, Accounting, Insurance,
SaaS, customer support, e-commerce).

- **[Developers](https://mycobrain.dev/for/builders)** building agents for production: one MCP server, a deterministic write path, and provenance you own.
- **[Vibecoders](https://mycobrain.dev/for/vibecoders)** shipping fast: persistent memory in one line, keyless and free, with no infra to build.
- **[Teams](https://mycobrain.dev/for/teams)** putting AI in a product: customer memory, isolated per tenant, on Postgres you own.
- **[Agencies](https://mycobrain.dev/for/agencies)**: every client in an isolated, auditable workspace.

## Architecture

<p align="center">
  <img src="./docs/architecture.svg" alt="Myco architecture — MCP clients call 11 brain tools through a deterministic write path into Postgres, the source of truth. A trust engine compounds confidence and supersedes contradictions. An optional, local-first LLM layer only proposes; it never becomes the store." width="100%">
</p>

The design is simple on purpose: **the database is authoritative, the write
path is programmatic, and LLMs assist without becoming the memory store.**

## Tool Surface

Myco Brain exposes 13 MCP tools:

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
- `brain_set_mode`
- `brain_self_check`

Full inputs, outputs, and examples for each tool: **[docs/api-reference.md](./docs/api-reference.md)**.

## Environment variables

The Docker quickstart needs **none** of these — it ships with seeded local
credentials and BM25 search works immediately. This is the reference for your
own deployment. Full annotated list with tuning thresholds:
[`.env.example`](./.env.example). Not sure what's active? Run `mycobrain-doctor`.

**Required**

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection string. The only hard requirement. |
| `BRAIN_API_KEY` | seeded | `brain_<workspace>_<agent>_<secret>` key; the quickstart ships a localdev key. |
| `BRAIN_WORKSPACE_ID` | from key | Derived from `BRAIN_API_KEY`; set explicitly only for service-role auth. |

**Semantic search** *(optional — without it, BM25 full-text still works)*

| Variable | Default | What it does |
|---|---|---|
| `BRAIN_EMBED_PROVIDER` | auto | `ollama` or `openai`; auto-selects by which credential is set. |
| `BRAIN_OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Local embedding model (no key, nothing leaves your machine). |
| `BRAIN_OPENAI_API_KEY` | — | Use OpenAI embeddings instead of local. |

**Knowledge graph** *(optional)*

| Variable | Default | What it does |
|---|---|---|
| `BRAIN_OLLAMA_BASE_URL` | — | Local extraction/embeddings endpoint (e.g. `http://localhost:11434`). |
| `BRAIN_OLLAMA_MODEL` | `llama3.2:3b` | Local extraction model. |
| `BRAIN_ANTHROPIC_API_KEY` | — | Most accurate graph; used automatically if set. |
| `BRAIN_EXTRACTION_PROVIDER` | auto | Force `ollama` or `anthropic`. |

**Trust dial** *(governance)*

| Variable | Default | What it does |
|---|---|---|
| `BRAIN_REQUIRE_HUMAN_REVIEW` | `0` | Strict curation — nothing the LLM proposes enters the graph without a human decision. |
| `BRAIN_SCHEMA_AUTO_PROMOTE` | `0` | Let corroborated new types promote themselves, audited and workspace-scoped. |

**Serving**

| Variable | Default | What it does |
|---|---|---|
| `BRAIN_REST_HOST` | `127.0.0.1` | Bind host for `mycobrain-rest`. Use `0.0.0.0` only behind your own TLS/proxy. |
| `BRAIN_REST_PORT` | `8787` | Read-only REST port. |
| `BRAIN_HEALTH_PORT` | `8080` | Health-check port. |

**Identity & security**

| Variable | Default | What it does |
|---|---|---|
| `BRAIN_REQUIRE_API_KEY_SECRET` | `0` | Require a registered `<secret>` for every agent key before auth succeeds. |
| `BRAIN_TRUST_REQUEST_IDENTITY` | `0` | **Stdio, multi-tenant gateways only.** Off: identity comes solely from env, so a caller-supplied `workspace_id`/`api_key` is ignored (prompt-injection-resistant). Set `1` only behind a gateway that authenticates each request. [Details ↑](#multi-tenant-gateways-who-is-the-caller-brain_trust_request_identity) |
| `BRAIN_AGENT_ID` | from key | Agent identity for service-role auth; derived from `BRAIN_API_KEY` otherwise. |
| `BRAIN_SERVICE_ROLE_KEY` | — | Supabase service-role JWT for trusted service callers (alternative to a `brain_` key). |

> Tuning thresholds (`BRAIN_SCHEMA_PROMOTE_MIN_SEEN`, `BRAIN_EXTRACTION_LEASE_MS`, `BRAIN_FUNCTIONAL_PREDICATES`, …) live in [`.env.example`](./.env.example).

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

- **Re-importing never duplicates** — each conversation is one content-hash-keyed
  document, so a re-run is a no-op. Continue a conversation and re-export, and the
  longer transcript imports as a new version alongside the old.
- **Branched ChatGPT threads import the ACTIVE branch** — the transcript you
  actually kept, not rejected regenerations.
- **Full provenance** — `brain_why` traces every imported fact back to its export file.

*Proof: `npm run test:export-import`.*

**Hands-free — watch your Downloads.** Request your export, then let Myco import
it the moment it lands, with no path to copy and nothing leaving your machine:

```bash
# Poll ~/Downloads and auto-import a ChatGPT/Claude export the second it arrives (Ctrl-C to stop)
mycobrain-ingest --watch-downloads

# Already downloaded it? Import whatever export is there, then exit
mycobrain-ingest --watch-downloads --once
```

Opt-in and deduplicated like any other import; point it at a different folder
with `BRAIN_WATCH_DIR` (needs `unzip` on your PATH).

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
- [Changelog](./CHANGELOG.md)
- [Audience + industry use cases](https://mycobrain.dev/for/builders)
- [Issue tracker](https://github.com/thegoodguysla/myco-brain/issues)
- [Cloud waitlist](https://mycobrain.dev)

## Who built this

Myco Brain was built by **Nick Taylor** — a growth marketer, not a career engineer — directing a team of AI coding agents. Roughly three months and about $6k in model spend, built with AI-assisted engineering. The point isn't the price tag; it's that a clear product vision plus modern agent tooling can now ship production-grade infrastructure — and this repo is the result: every claim on this page names a runnable check (see [Every claim has a check](#every-claim-has-a-check)), so you can judge it yourself rather than take the origin story on faith.

**Like this?** A ⭐ helps others find it, and *Watch → Releases* (top of the page) will ping you when new capabilities ship — see the [roadmap](./ROADMAP.md) for what's next.

**Want this for your team?** If your company wants someone who can build agent systems, automation, and growth engineering like this, that's what **The Good Guys** does — email [nick@thegoodguys.la](mailto:nick@thegoodguys.la) or [book a call](https://calendar.app.google/B6pSrRvv3FWX9C4u8).
