# Myco Brain Quickstart

This is the fastest verified path from fresh clone to first memory retrieval.

## Prerequisites

- Docker + Docker Compose v2
- An MCP client such as Claude Desktop, Cursor, Continue, Windsurf, or Zed
- No API keys required for the first run

## 1. Clone and boot

```bash
git clone https://github.com/thegoodguysla/myco-brain.git
cd myco-brain
docker compose up -d
```

This starts:

- Postgres 16 + pgvector
- MCP server
- extraction worker

BM25 search works immediately. Add these later if needed:

- `BRAIN_OPENAI_API_KEY` for vector search
- `BRAIN_ANTHROPIC_API_KEY` for extraction
- `BRAIN_COHERE_API_KEY` for reranking

## 2. Verify the stack

```bash
docker compose ps
docker compose config
```

Expected result: compose config renders successfully and all three services are present.

## 3. Connect Claude Desktop

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

Restart Claude Desktop after saving the config.

## 4. First memory test

In Claude Desktop:

```text
Save a memory: the launch checklist lives in the ops folder.
```

Open a fresh conversation and ask:

```text
Where does the launch checklist live?
```

Expected result: the second session retrieves the saved fact.

## 5. Optional follow-up checks

Provenance:

```text
Why do we think the launch checklist lives in the ops folder?
```

Graph:

```text
Show related entities for the launch checklist.
```

Memory health:

```text
Show my Myco memory stats.
```

Expected result: `brain_stats` returns a snapshot — documents stored, knowledge-graph size, what share of proposed facts are source-backed, how many are pending review, and the idempotent write count. This is the structured, traceable memory that a plain vector store can't show you.

## 6. Bulk-ingest a folder or repo

Seed Brain with content in one command. The `mycobrain-ingest` CLI walks a
directory (or clones a GitHub repo) and indexes every text file — immediately
searchable, each result traceable to its source file.

```bash
export DATABASE_URL=postgresql://brain:brain@localhost:5432/brain
export BRAIN_WORKSPACE_ID=00000000-0000-0000-0000-000000000001
export BRAIN_API_KEY=brain_00000000-0000-0000-0000-000000000001_00000000-0000-0000-0000-0000000000a1_localdev

# Try the bundled demo corpus (a fictional agency + its client),
# then point it at your own folder or a repo:
npx -y -p @mycobrain/mcp-server mycobrain-ingest ./examples/demo-corpus
npx -y -p @mycobrain/mcp-server mycobrain-ingest ./docs
npx -y -p @mycobrain/mcp-server mycobrain-ingest github:owner/repo
```

It skips binaries and noise dirs (`node_modules`, `.git`, `dist`, …) and files
over 1 MB. Set `GITHUB_TOKEN` for private repos.

After ingesting the demo corpus, ask a connected agent:

```text
When does Northwind's rebrand launch, and who owns the account?
```
```text
What pricing model did we choose for Northwind, and why?
```
```text
Show me the source for the launch date.
```

Each answer traces back to the file it came from — `brain_why` returns the
source chain, and `brain_stats` shows how much of your memory is source-backed.

## What You Get

The MCP server exposes 11 tools:

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
