# Dedup + provenance benchmark

A small, reproducible check of the two claims at the core of Myco Brain — so you
don't have to take our word for it.

- **Dedup:** re-ingesting identical content does *not* create duplicate memory.
  It's rejected by content hash. (This is what prevents the "same fact saved ten
  times in slightly different words" failure mode that plagues LLM-written
  memory.)
- **Provenance:** every stored document carries a content hash and is
  source-traceable.

## Run it

With the stack running (`docker compose up -d`) and a built `mcp-server`:

```bash
export DATABASE_URL=postgresql://brain:brain@localhost:5432/brain
export BRAIN_WORKSPACE_ID=00000000-0000-0000-0000-000000000001
export BRAIN_API_KEY=brain_00000000-0000-0000-0000-000000000001_00000000-0000-0000-0000-0000000000a1_localdev

node examples/benchmark/run.mjs
```

## What you'll see

It ingests 3 documents, then ingests the same 3 again (simulating overlapping
sources or a re-run), and reports:

```
  Ingest attempts (overlapping sources):    6
  Unique documents actually stored:         3
  Duplicate writes blocked by content hash: 3
  Stored docs with a content hash:          3/3 (100% source-traceable)
  ✅ DEDUP: identical content did not create duplicates.
  ✅ PROVENANCE: every stored document is source-traceable.
```

The script exits non-zero if either property fails, so it doubles as a check you
can run in CI. Each run is tagged uniquely, so running it repeatedly won't
pollute or collide with real data.
