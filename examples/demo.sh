#!/usr/bin/env bash
# Myco Brain — narrated terminal demo (great for an asciinema recording).
#
# Prereqs: the stack is up (`docker compose up -d`) and these env vars are set
# (the defaults match the seeded local workspace):
#   export DATABASE_URL=postgresql://brain:brain@localhost:5432/brain
#   export BRAIN_WORKSPACE_ID=00000000-0000-0000-0000-000000000001
#   export BRAIN_API_KEY=brain_00000000-0000-0000-0000-000000000001_00000000-0000-0000-0000-0000000000a1_localdev
# Optional (to show the knowledge graph build live, no API key):
#   export BRAIN_OLLAMA_BASE_URL=http://localhost:11434   # with `ollama pull llama3.2:3b`
#
# Record it:
#   brew install asciinema agg
#   asciinema rec demo.cast -c "bash examples/demo.sh"
#   agg demo.cast demo.gif        # or: svg-term --in demo.cast --out demo.svg
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
say() { printf "\n\033[1;36m# %s\033[0m\n" "$1"; sleep 1; }
run() { printf "\033[0;90m\$ %s\033[0m\n" "$1"; sleep 0.5; eval "$1"; }

say "1) The stack is running — Postgres + MCP server + extraction worker"
run "docker compose ps --format '{{.Service}}: {{.Status}}'"

say "2) Give it a memory — ingest a folder of documents (no API key needed)"
run "node mcp-server/dist/ingest-cli.js ./examples/demo-corpus"

say "3) Deterministic + deduplicated: re-ingesting identical content is blocked"
run "node examples/benchmark/run.mjs"

if [ -n "${BRAIN_OLLAMA_BASE_URL:-}" ] || [ -n "${BRAIN_ANTHROPIC_API_KEY:-}" ]; then
  say "4) Build the knowledge graph — entities + relationships (here: fully local)"
  run "node mcp-server/dist/extraction-worker.js --once"
  say "   The graph now connects facts to each other — try asking a connected agent:"
  printf '     "How does Mara Quinn connect to Northwind?"\n'
  printf '     "Show my Myco memory stats."\n'
else
  say "4) Set BRAIN_OLLAMA_BASE_URL (local Ollama) or BRAIN_ANTHROPIC_API_KEY to build the graph"
fi

say "Done. Your agent now has shared, source-backed memory in your own Postgres."
