# Relationship extraction & direction quality

Myco's extraction worker pulls **entities** and the **directed relationships**
between them out of ingested text and writes them into the knowledge graph.
Relationships are directed — `subject → predicate → object` — and getting the
direction right matters: "Northwind hired Lumen" and "Lumen hired Northwind"
are opposite facts.

Small local models are prone to **direction errors**: they extract the right
two entities but in the wrong order, especially in passive voice ("Lumen *was
hired by* Northwind"). The extraction prompt is written to counter this — it
states that relations are directed, defines subject vs. object, and gives worked
directional examples (including the passive trap).

## Recommended model

| Use case | Provider | Model | Notes |
| --- | --- | --- | --- |
| **Local & free (recommended)** | Ollama | `llama3.2:3b` | Good direction accuracy with the shipped prompt; runs on a laptop. Set `BRAIN_OLLAMA_BASE_URL` (+ optional `BRAIN_OLLAMA_MODEL`). |
| **Best accuracy** | Anthropic | `claude-sonnet-4` | Set `BRAIN_ANTHROPIC_API_KEY`. |

A larger local model (e.g. an 8B-class instruct model) will push direction
accuracy higher still; `llama3.2:3b` is the recommended floor because it is
small enough to run anywhere while still handling direction well.

## Measured direction accuracy

Measured on the gold fixture in `mcp-server/src/extraction-direction.ts` — 14
clearly-directed facts drawn from `examples/demo-corpus`, including passive-voice
direction traps. "Directed accuracy" = fraction with the correct subject→object
order.

| Model | Prompt | Directed accuracy | Reversed |
| --- | --- | --- | --- |
| `ollama:llama3.2:3b` | shipped (direction-aware) | **93%** (13/14) | 1 |
| `ollama:llama3.2:3b` | prior (direction-blind) | 79% (11/14) | 3 |

The direction-aware prompt repairs most reversals; the one residual miss is the
hardest passive case ("Devin Osei was hired by Lumen"). Numbers move a little
run-to-run (LLMs aren't perfectly deterministic even at temperature 0).

## Endpoint recovery (edge survival)

Small models frequently emit a correct relation while **omitting one endpoint
from `entities`**. The worker deliberately never creates entities from
relations (anti-hallucination), so such relations used to be dropped — on the
gold fixture, `llama3.2:3b` produced **0%** relations with both endpoints
listed, i.e. effectively no graph edges from a fresh keyless install.

`extract()` now runs a best-effort second pass when this happens: the model is
asked to classify *exactly the missing names* against the same text (an
example-anchored prompt; any extra names it returns are discarded). Junk
phrase-objects (e.g. *"paid acquisition for Northwind Coffee"*) are still
rejected — that's the guard working as intended.

| Model | Edge survival (both endpoints in entities) |
| --- | --- |
| `ollama:llama3.2:3b` without recovery | 0% (0/14) |
| `ollama:llama3.2:3b` with recovery | **79%** (11/14; remainder are junk objects, correctly rejected) |

The regression check measures this as **endpoint completeness** and fails
below `BRAIN_ENDPOINT_MIN_COMPLETENESS` (default 0.75). Direction accuracy is
unchanged by the recovery pass.

## Running the regression check

```bash
cd mcp-server && npm run build

# Local (Ollama) — pull a chat model first: `ollama pull llama3.2:3b`
BRAIN_EXTRACTION_PROVIDER=ollama BRAIN_OLLAMA_BASE_URL=http://localhost:11434 \
  npm run test:direction

# Or against Anthropic:
BRAIN_EXTRACTION_PROVIDER=anthropic BRAIN_ANTHROPIC_API_KEY=sk-ant-... \
  npm run test:direction
```

The check fails when directed accuracy falls below `BRAIN_DIRECTION_MIN_ACCURACY`
(default `0.8`) — high enough to catch a regression to the old direction-blind
prompt (79%), low enough to absorb normal model variance. It **skips** (exit 0)
when no real extraction model is configured, so it never blocks the keyless CI
quickstart. No database is required.

The pure scoring logic (`scoreDirection`, entity matching, fixture shape) is
covered by deterministic unit tests in
`mcp-server/src/extraction-direction.test.ts`, which run in CI.
