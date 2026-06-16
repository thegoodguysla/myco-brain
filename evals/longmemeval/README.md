# LongMemEval harness for Myco Brain

This harness runs the [LongMemEval](https://github.com/xiaowu0162/LongMemEval)
long-term-memory QA benchmark against Brain's retrieval + reasoning stack and
reports a real, reproducible accuracy number.

> **Headline (oracle subset, FULL — no sampling):** **73.6% end-to-end QA
> accuracy on all 500 oracle questions** (reader `gpt-4o-mini`, judge
> **`gpt-4o`**), with **100% evidence-retrieval recall**. See
> [Results](#results) for the full breakdown and the exact commands to
> reproduce.

> **Verify without re-running:** the two canonical `n=500` oracle runs behind these
> numbers are committed under [`results/`](./results/) —
> `run_20260612T003829_n500.json` (73.6%, reader `gpt-4o-mini`) and
> `run_20260612T212512_n500.json` (71.8%, reader `gpt-4o`). Open either and read
> `qa.accuracy` and `qa.by_category`. Fresh runs land in the same dir (gitignored).

---

## What this measures

LongMemEval gives a model a long conversational history (the *haystack*) and a
question whose answer is buried somewhere in it. We evaluate the **`oracle`**
subset: for each question the haystack contains *only* the evidence sessions, so
retrieval is not the bottleneck — oracle isolates whether the system can **find
and reason over the right memory to actually answer the question**.

Accordingly the **headline metric is end-to-end QA accuracy**, the same metric
the official benchmark reports. Substring/recall metrics are inadequate here:
only ~51% of oracle answers even appear verbatim in the haystack, and whole
categories (e.g. temporal-reasoning, where answers like "7 days" are *computed*)
never do.

### Pipeline (per question)

1. **Isolate** — each question gets its own Brain workspace. LongMemEval
   haystacks are independent, so the faithful mapping is *one workspace = one
   user's memory*. This also exercises Brain's normal workspace-scoped search
   path and stops one question's sessions from polluting another's retrieval.
2. **Ingest** — every session becomes a Brain `hyobject` (chunked + embedded),
   timestamped with the session's **real date** from the dataset
   (`haystack_dates`) so temporal questions are answerable.
3. **Retrieve** — Brain's hybrid search (pgvector cosine → BM25 re-rank → entity
   boost) returns the most relevant chunks. We also run two variants for
   comparison: `temporal` (recency-biased) and `two_pass` (pseudo-relevance
   feedback). This is what the retrieval metrics score.
4. **Read** — a reader LLM answers using *only* the retrieved memories. Because
   LongMemEval sessions are long multi-topic conversations (often 15–20+ chunks
   each), we retrieve at chunk granularity but feed the reader the **full text
   of each distinct surfaced session**, each labelled with its date — the
   standard memory-benchmark reader setup.
5. **Judge** — a judge LLM rules the answer correct/incorrect against the gold
   answer. The judge prompts are a faithful reimplementation of the official
   LongMemEval evaluator (`evaluate_qa.py`), including the category-specific
   variants for temporal-reasoning, knowledge-update, single-session-preference,
   and abstention (`_abs`) questions.

### Metrics reported

| Metric | What it means |
| --- | --- |
| **QA accuracy** (headline) | Fraction of questions the judge rules correct, end-to-end. |
| **Ev@k** (evidence recall) | Did the top-k retrieved chunks include a labelled evidence session (`answer_session_ids`)? The honest retrieval metric. |
| **R@k / EM / F1** (lexical) | Verbatim-substring proxies. Reported for continuity but they *under-count heavily* on this benchmark — diagnostic only. |

---

## Results

All runs: Postgres 17 + pgvector locally, OpenAI `text-embedding-3-small`
embeddings, reader `gpt-4o-mini`, on the `longmemeval_oracle` subset. The
judge model is noted per run.

### Full oracle subset, gpt-4o judge (the headline)

```
python -m evals.longmemeval.run --examples 500 --subset longmemeval_oracle --judge-model gpt-4o
```

All 500 oracle questions — no sampling — with the judge upgraded to `gpt-4o`
so the grading itself is beyond question (the reader stays `gpt-4o-mini` so
anyone can reproduce the run for a few dollars).

| | QA accuracy |
| --- | --- |
| **Overall (n=500)** | **73.6%** |
| single-session-assistant (n=56) | 100.0% |
| single-session-user (n=70) | 94.3% |
| knowledge-update (n=78) | 78.2% |
| multi-session (n=133) | 68.4% |
| temporal-reasoning (n=133) | 68.4% |
| single-session-preference (n=30) | 10.0% |

Evidence recall (Ev@1/5/10) = **100%** for all retrieval strategies. The
`single-session-preference` category is the known outlier for factual readers:
the gold answers grade *stylistic preference-following*, not retrieval — the
evidence is found (100%), but a factual answer is graded as a miss. Excluding
that category, accuracy on the remaining 470 questions is **77.7%**.

### Reader sensitivity — two configs, published side by side

Same harness, same 500 oracle questions, same gpt-4o judge — only the reader
(answering model) changes:

| Config | Reader | QA accuracy | Ex-preference (470q) | Mean tokens/query |
| --- | --- | --- | --- | --- |
| Cheap-reproducible | `gpt-4o-mini` | **73.6%** | 77.7% | —¹ |
| Strong-reader | `gpt-4o` | **71.8%** | 76.4% | **5,567** |

```
python -m evals.longmemeval.run --examples 500 --subset longmemeval_oracle \
  --reader-model gpt-4o --judge-model gpt-4o
```

The strong reader scores 1.8 points LOWER. With evidence recall already at
100%, the reader is not the binding constraint — the memory layer is
saturated and the residual is answer-style/judge interaction (gpt-4o scores
0% on the style-graded preference category where the mini reader gets 10%,
and trades multi-session for temporal-reasoning accuracy). This is measured
evidence that **LongMemEval headlines are reader-sensitive: comparing single
headline numbers across systems with different readers, retrieval budgets,
and platforms is meaningless.** We publish both configs so nobody has to
take our word for which one flatters us.

¹ tokens/query instrumentation landed after the gpt-4o-mini run; its number
will be added on the next re-run (the gpt-4o config's 5,567 mean prompt
tokens ≈ the retrieved memory payload per question).

### Representative cross-category sample (gpt-4o-mini judge, earlier run)

```
python -m evals.longmemeval.run --examples 100 --subset longmemeval_oracle --shuffle --seed 0
```

| | QA accuracy |
| --- | --- |
| **Overall (n=100)** | **77.0%** |
| single-session-assistant (n=11) | 100.0% |
| single-session-user (n=14) | 92.9% |
| knowledge-update (n=19) | 78.9% |
| temporal-reasoning (n=26) | 73.1% |
| multi-session (n=27) | 66.7% |
| single-session-preference (n=3) | 33.3% |

Evidence recall (Ev@1/5/10) = **100%** for all strategies — on the oracle subset
the haystack is only evidence, so a correctly-isolated workspace always surfaces
it. (The oracle file is ordered by category, so `--shuffle --seed 0` is used to
get a representative mix; the first-N rows are all one category.)

### Plan acceptance run (`--examples 20`, hardest category)

```
python -m evals.longmemeval.run --examples 20 --subset longmemeval_oracle
```

The first 20 oracle rows are all **temporal-reasoning** (the hardest category —
answers are computed durations, never stated). Result: **75% QA accuracy** at
**100% evidence recall**.

> Numbers depend on the reader/judge models (`gpt-4o-mini` here, configurable —
> the official harness uses `gpt-4o`) and will move a few points run-to-run
> because the LLMs are not perfectly deterministic. Run the full 500-question
> set with `--examples 500` (no `--shuffle` needed).

---

## Running it

### Prerequisites

- **Postgres + pgvector** with Brain's schema, reachable via `DATABASE_URL`
  (or `SUPABASE_DB_URL`). For local dev that is
  `postgresql://brain:brain@localhost:5432/brain`.
- **`OPENAI_API_KEY`** (read from the repo-root `.env`) — used for embeddings,
  the reader, and the judge. Without it the harness reports retrieval metrics
  only.
- Python deps: `pip install -r requirements.txt`.

```bash
cd evals/longmemeval
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export DATABASE_URL="postgresql://brain:brain@localhost:5432/brain"
# OPENAI_API_KEY is loaded from the repo-root .env automatically.

# From the repo root:
python -m evals.longmemeval.run --examples 100 --subset longmemeval_oracle --shuffle --seed 0
```

> **Local note:** the dev DB is initialised with `client_encoding=SQL_ASCII`
> (a side effect of running Postgres under `LC_ALL=C`). The harness forces
> `client_encoding=UTF8` on its connections so text columns decode to `str`;
> still run `psql` with `LC_ALL=C` for other tooling.

### Useful flags

| Flag | Default | Purpose |
| --- | --- | --- |
| `--examples N` / `-n` | 200 | Number of questions to evaluate. |
| `--subset` | `longmemeval_s` | `longmemeval_oracle` / `_s` / `_m`. |
| `--shuffle` / `--seed` | off / 0 | Seeded shuffle for a representative cross-category sample. |
| `--qa` / `--no-qa` | on | Run the end-to-end QA reader+judge (needs `OPENAI_API_KEY`). |
| `--reader-model` / `--judge-model` | `gpt-4o-mini` | Override reader / judge (env: `LONGMEMEVAL_QA_MODEL`, `LONGMEMEVAL_JUDGE_MODEL`). |
| `--no-purge` | purges | Keep the per-question workspaces after the run. |
| `--dry-run` | off | Load + report dataset stats only. |

### Offline unit tests

Pure logic (date parsing, dataset normalization, bytes-tolerant tokenization,
judge-prompt selection, metric aggregation) — no DB, network, or LLM:

```bash
pytest evals/longmemeval/tests
```

---

## Layout

| File | Responsibility |
| --- | --- |
| `dataset.py` | Download/parse the benchmark; normalize rows (dates, evidence ids, roles). |
| `ingest.py` | Write each session into Brain as a dated, chunked, embedded hyobject. |
| `search.py` | Re-implementation of Brain's hybrid / temporal / two-pass retrieval. |
| `qa.py` | Reader (answer from retrieved sessions) + faithful LongMemEval judge. |
| `metrics.py` | QA accuracy, evidence recall, lexical proxies, report formatting. |
| `harness.py` | Orchestration: isolate → ingest → retrieve → read → judge → aggregate. |
| `run.py` | Typer CLI entry point. |

## Notes & caveats

- **Oracle measures reasoning, not retrieval difficulty.** Evidence recall is
  ~100% by construction; the interesting signal is QA accuracy. Run `_s` / `_m`
  to stress retrieval against large distractor haystacks (Ev@k becomes
  meaningful there).
- **Judge fidelity.** The judge is a faithful reimplementation of the official
  prompts but uses `gpt-4o-mini` by default for cost. For a citable number,
  re-run with `--judge-model gpt-4o`.
- `.cache/`, `results/`, and `.venv/` are git-ignored local artifacts.
