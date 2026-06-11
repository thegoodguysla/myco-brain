# Contributing to Myco Brain

Thanks for contributing. Myco Brain is open-source infrastructure for agent memory, provenance, and deterministic retrieval.

## Ground Rules

- Keep changes scoped.
- Update docs when you change the public surface.
- Add or update tests when behavior changes.
- Do not include internal-only artifacts, runbooks, or planning docs in OSS changes.

## Development Setup

```bash
git clone https://github.com/thegoodguysla/myco-brain.git
cd myco-brain
docker compose up -d
cd mcp-server
npm install
npm run lint
npm run typecheck
npm test
```

Optional env vars:

- `BRAIN_OPENAI_API_KEY` for vector embeddings
- `BRAIN_ANTHROPIC_API_KEY` for extraction worker
- `BRAIN_COHERE_API_KEY` for reranking

## Repo Layout

- `mcp-server/` — MCP server source
- `supabase/migrations/` — Postgres schema
- `docs/` — public setup docs
- `examples/` — client config examples

## Pull Requests

1. Open or reference an issue first when the change is non-trivial.
2. Keep each PR to one logical change.
3. Describe user impact, test coverage, and any schema or env var changes.
4. If you change a tool contract, update the README and quickstart docs in the same PR.

## Verification Checklist

Before opening a PR, run:

```bash
cd mcp-server
npm run lint
npm run typecheck
npm test
```

If you touch Docker or docs, also run:

```bash
cd ..
docker compose config
```

## Community Standards

By participating, you agree to the rules in [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
