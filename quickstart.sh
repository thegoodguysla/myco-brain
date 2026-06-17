#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Myco Brain guided quickstart.
#
# The core is keyless and works out of the box: full-text (BM25) search,
# ingestion, provenance (brain_why), dedup, shared cross-agent memory.
#
# Semantic (vector) search and the knowledge graph are OPTIONAL. This script can
# turn them on with one "yes": it runs Ollama IN DOCKER (no host install, Docker
# is the only prerequisite) and downloads the models once (~2.3GB total:
# nomic-embed-text for embeddings + llama3.2:3b for extraction).
#
# Non-interactive override: set MYCO_WITH_OLLAMA=1 (enable) or =0 (keyless core).

ENABLE_OLLAMA="${MYCO_WITH_OLLAMA:-}"
if [ -z "$ENABLE_OLLAMA" ] && [ -t 0 ]; then
  printf '\n  Enable local semantic search + knowledge graph?\n'
  printf '  Runs Ollama in Docker and downloads ~2.3GB of models once.\n'
  printf '  (The keyless core works fine without this.)\n\n'
  printf '  Enable now? [y/N] '
  read -r ans
  case "$ans" in [Yy]*) ENABLE_OLLAMA=1 ;; *) ENABLE_OLLAMA=0 ;; esac
fi
ENABLE_OLLAMA="${ENABLE_OLLAMA:-0}"

# Ensure a .env exists (defaults match the seeded local workspace).
[ -f .env ] || { [ -f .env.example ] && cp .env.example .env; }

set_env() { # set_env KEY VALUE  (idempotent, in-place)
  local k="$1" v="$2" tmp
  if [ -f .env ] && grep -qE "^${k}=" .env; then
    tmp="$(mktemp)"; sed "s|^${k}=.*|${k}=${v}|" .env >"$tmp" && mv "$tmp" .env
  else
    printf '%s=%s\n' "$k" "$v" >>.env
  fi
}

if [ "$ENABLE_OLLAMA" = "1" ]; then
  set_env BRAIN_EMBED_PROVIDER ollama
  set_env BRAIN_OLLAMA_BASE_URL http://ollama:11434
  echo
  echo "==> Starting Myco Brain with local semantic search + graph (Ollama in Docker)…"
  docker compose --profile with-ollama up -d
  echo "==> Pulling models on first run (one-time). Semantic search + extraction"
  echo "    activate automatically once 'myco_ollama_init' finishes:"
  echo "      docker compose logs -f ollama-init"
else
  # Keep providers empty -> keyless BM25 core (honest default).
  set_env BRAIN_EMBED_PROVIDER ""
  set_env BRAIN_OLLAMA_BASE_URL ""
  echo
  echo "==> Starting Myco Brain (keyless core: full-text search + ingestion + provenance)…"
  docker compose up -d
  echo "    To add semantic search + the graph later, re-run ./quickstart.sh and answer yes."
fi

echo
echo "Up. Verify with:  docker compose logs -f mcp-server"
echo "Stats once ingested:  the brain_stats tool (embedded_chunks, relations, people)."
