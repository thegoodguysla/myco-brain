# Teach your agent to use Myco Brain well

Myco Brain works out of the box: connect the MCP server and every tool is
self-describing — Claude, Cursor, and friends can call `brain_search` or
`brain_save_memory` the moment they're connected (CI proves the full loop on
every commit).

But there's a difference between an agent that *can* use memory and one that
*uses it well*. Tool descriptions tell the model **what** each tool does; they
don't tell it **when** your team wants memory consulted or updated. That
behavioral contract belongs in your project instructions — and giving the
agent one paragraph of policy is the single highest-leverage setup step.

## The copy-paste block

Add this to your project's agent instructions — `CLAUDE.md` (Claude Code),
`.cursorrules` (Cursor), or the equivalent for your client:

```markdown
## Persistent memory (Myco Brain)

This project has persistent, shared memory via the `brain_*` MCP tools.

- **Starting a task?** Call `brain_context_pack` with the task topic FIRST —
  prior decisions, entities, and related documents may already exist.
- **Learned something durable?** Save it: `brain_save_memory` — one clear
  fact per call (decisions, constraints, preferences, deadlines). Don't save
  session chatter, secrets, or anything derivable from the code.
- **Asked "why" or "since when"?** Use `brain_why` — answer with the source,
  not from vibes. If memory and the user disagree, say so and cite.
- **Searching documents?** `brain_search` / `brain_context_pack` are for
  ingested workspace knowledge; `brain_recall_memory` is for YOUR OWN saved
  memories.
- Trust the confidence signals: facts marked superseded are history, not
  current truth.
```

That's it. Agents given this block start sessions by recalling context, save
the right things, and cite sources when challenged.

## Connection checklist (when tools error)

**First, run the doctor** — it diagnoses the whole chain in one command:

```bash
npx -y -p @mycobrain/mcp-server mycobrain-doctor
```

It checks the database, migrations, your workspace + key, whether semantic
search and the knowledge graph are switched on, and what's waiting in the
review queue — printing the exact fix for anything red. With no env set it
checks the quickstart stack.

Symptoms like `Validation error: Required` or empty results almost always mean
the **server process** is missing its environment, not that the agent is using
the tools wrong:

1. The MCP server needs `DATABASE_URL`, `BRAIN_WORKSPACE_ID`, and
   `BRAIN_API_KEY` in its `env` block (see the
   [README's Claude Desktop example](../README.md#connect-claude-desktop) —
   the same shape works for Claude Code's `.mcp.json` and Cursor).
2. **Changed the config or rebuilt the server? Restart the client.** MCP
   servers are spawned once per session; a stale process keeps stale schemas.
3. Local quickstart credentials are seeded and universal (workspace
   `…0001` + the `…_localdev` key) — they are not secrets and work on any
   fresh `docker compose up` stack.
4. Multi-agent setups: give each agent its own `BRAIN_AGENT_ID` so private
   memories and provenance attribute correctly (see
   [per-object privacy](../README.md#private-memories-shared-knowledge)).

## Patterns that work

- **Session-start recall** — `brain_context_pack("the task topic")` before
  exploring code or files. Cheapest way to stop re-deciding decided things.
- **Decision journaling** — after any "let's go with X" moment:
  `brain_save_memory("Decided X because Y — applies to Z")`.
- **The provenance reflex** — any time an agent asserts a remembered fact in
  something user-facing, `brain_why` it and cite the source document.
- **Import your history** — bulk-ingest the docs, notes, and repos you
  already have (`mycobrain-ingest ./docs`, `mycobrain-ingest
  github:owner/repo`) so memory is useful on day one.
- **Watch the stats** — `brain_stats` in a weekly ritual: pending review
  counts, proposed new types, corroborated vs superseded facts. Memory you
  can audit is memory you can trust.
