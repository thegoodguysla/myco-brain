# Agent-contract eval

Turns "the instructions feel right" into a number. It measures whether an agent,
given Myco's runtime contract and the real `brain_*` tool descriptions, routes to
the **right tool** for each situation — and how often it wrongly reaches for the
`brain_save_memory` scratchpad when a fact belongs in the program.

## What it does

For each scenario in `scenarios.json` it calls the Anthropic Messages API with:
- `system` = the single-sourced `RUNTIME_CONTRACT` (from `src/agent-instructions.ts`)
- `tools` = the `brain_*` tool schemas (their descriptions drive selection)
- `user` = the scenario's `situation`

then scores the **first tool** the model reaches for against the scenario's
`expected_tool`, and flags the dominant failure mode (`save_memory` misuse).

## Run

```bash
ANTHROPIC_API_KEY=sk-... npm run eval:contract
# options: BRAIN_EVAL_MODEL=claude-sonnet-4-6  BRAIN_EVAL_BAR=90
```

Without a key it skips cleanly (like the DB-gated tests). It prints per-scenario
results, overall adherence %, the `save_memory`-misuse rate, and a per-category
breakdown; exits non-zero below the bar (default 90%).

## The loop (how this earns confidence, not asserts it)

1. Run the eval. 2. Read the misses — especially any `ANTI` (reached for
`save_memory` when a source should have been ingested). 3. Sharpen the
`RUNTIME_CONTRACT` / tool descriptions to fix the specific failure. 4. Re-run.
Repeat until adherence clears the bar. The scenarios are the regression net: a
future edit that weakens routing shows up here.

## Drift guard (CI, no network)

```bash
npm run check:contract-drift
```

Fails if the contract surfaces (manual, docs, homepage) diverge on the
load-bearing line, or if the runtime contract stops being single-sourced from
`agent-instructions.ts`.

## Adding scenarios

Append to `scenarios.json`: `{ id, category, situation, expected_tool,
rationale, anti_pattern, difficulty }`. Make `situation` read like a real user or
task message, and set `anti_pattern` to the tempting wrong move.
