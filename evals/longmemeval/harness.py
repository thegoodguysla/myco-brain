"""
LongMemEval evaluation harness.

Orchestrates:
  1. Dataset loading
  2. Workspace setup + ingestion
  3. Per-example search evaluation across three strategies:
       - hybrid       (BM25 + vector, Brain's default)
       - temporal     (recency-biased variant)
       - two_pass     (pseudo-relevance feedback expansion)
  4. Metric aggregation and report output

Usage (programmatic):
    results = asyncio.run(run_eval(max_examples=200))

Usage (CLI):
    python -m evals.longmemeval.run [--examples 200] [--no-purge]
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Awaitable

import psycopg
from tqdm import tqdm

from .dataset import LongMemExample, load_dataset
from .db import ensure_eval_workspace, purge_eval_workspace, session
from .embed import Embedder, get_embedder
from .ingest import ingest_examples
from .metrics import (
    QAResult,
    StrategyResult,
    aggregate,
    aggregate_qa,
    evidence_recall_at_k,
    exact_match,
    format_report,
    recall_at_k,
    top_f1,
)
from .qa import (
    DEFAULT_JUDGE_MODEL,
    DEFAULT_READER_MODEL,
    generate_answer,
    judge_answer,
)
from .search import SearchHit, hybrid_search, temporal_search, two_pass_search

RESULTS_DIR = Path(__file__).parent / "results"

# Deeper retrieval just for the QA reader, so multiple distinct sessions are
# represented before we dedupe to whole sessions (the per-strategy retrieval
# metrics still use the standard top-20).
QA_RETRIEVAL_LIMIT = 50


async def _eval_example(
    conn: psycopg.AsyncConnection,
    example: LongMemExample,
    embedding: list[float],
    embedder: Embedder,
    workspace_id: str,
    evidence_ids: set[str],
    qa_client=None,
    reader_model: str = DEFAULT_READER_MODEL,
    judge_model: str = DEFAULT_JUDGE_MODEL,
) -> dict:
    """Run all three retrieval strategies (and optional QA) on one example."""

    async def run_strategy(
        fn: Callable[..., Awaitable[list[SearchHit]]],
        limit: int = 20,
        **kwargs,
    ) -> list[SearchHit]:
        try:
            return await fn(
                conn,
                example.question,
                embedding,
                workspace_id=workspace_id,
                limit=limit,
                **kwargs,
            )
        except Exception as exc:
            print(f"  [warn] Search failed for {example.question_id}: {exc}")
            return []

    hybrid_hits = await run_strategy(hybrid_search)
    temporal_hits = await run_strategy(temporal_search)
    two_pass_hits = await run_strategy(two_pass_search, embedder=embedder)

    def metrics(hits: list[SearchHit]) -> dict:
        return {
            "r1": float(recall_at_k(hits, example.answer_span, 1)),
            "r5": float(recall_at_k(hits, example.answer_span, 5)),
            "r10": float(recall_at_k(hits, example.answer_span, 10)),
            "ev1": float(evidence_recall_at_k(hits, evidence_ids, 1)),
            "ev5": float(evidence_recall_at_k(hits, evidence_ids, 5)),
            "ev10": float(evidence_recall_at_k(hits, evidence_ids, 10)),
            "em": float(exact_match(hits, example.answer)),
            "f1": top_f1(hits, example.answer_span),
            "category": example.category,
        }

    row = {
        "question_id": example.question_id,
        "hybrid": metrics(hybrid_hits),
        "temporal": metrics(temporal_hits),
        "two_pass": metrics(two_pass_hits),
    }

    # End-to-end QA on the default (hybrid) retrieval — the headline metric.
    if qa_client is not None:
        # Retrieve a deeper candidate set for the reader so multiple distinct
        # sessions surface (LongMemEval sessions are long and one can dominate
        # the top-20 chunks, starving multi-session questions of the other
        # evidence). The reader then reads the top distinct sessions whole.
        qa_hits = await run_strategy(hybrid_search, limit=QA_RETRIEVAL_LIMIT)
        try:
            answer, reader_tokens = await asyncio.to_thread(
                generate_answer, qa_client, example, qa_hits, reader_model
            )
            correct = await asyncio.to_thread(
                judge_answer, qa_client, example, answer, judge_model
            )
        except Exception as exc:  # noqa: BLE001
            print(f"  [warn] QA failed for {example.question_id}: {exc}")
            answer, correct = "", False
            reader_tokens = {"prompt_tokens": 0, "total_tokens": 0}
        row["qa"] = {
            "correct": bool(correct),
            "category": example.category,
            "generated": answer,
            "gold": example.answer,
            "reader_prompt_tokens": reader_tokens["prompt_tokens"],
            "reader_total_tokens": reader_tokens["total_tokens"],
        }

    return row


async def run_eval(
    max_examples: int = 200,
    dataset_split: str = "test",
    dataset_subset: str = "longmemeval_s",
    purge_after: bool = True,
    qa: bool = True,
    reader_model: str = DEFAULT_READER_MODEL,
    judge_model: str = DEFAULT_JUDGE_MODEL,
    shuffle: bool = False,
    seed: int = 0,
) -> tuple[list[StrategyResult], QAResult | None]:
    """
    Full evaluation pipeline.

    Returns (retrieval StrategyResults, QAResult | None). The QAResult holds
    the headline end-to-end accuracy; it is None when QA is disabled or no
    OpenAI key is available.
    """
    print(f"\n{'='*60}")
    print(f"LongMemEval Harness — {datetime.now(timezone.utc).isoformat()}")
    print(f"Subset:    {dataset_subset}")
    print(f"Examples:  {max_examples}")
    print(f"Isolation: one workspace per question (independent haystacks)")
    print(f"{'='*60}\n")

    # ── 1. Load dataset ──────────────────────────────────────────────────
    examples = load_dataset(
        split=dataset_split,
        max_examples=max_examples,
        subset=dataset_subset,
        shuffle=shuffle,
        seed=seed,
    )
    print(f"Loaded {len(examples)} examples.\n")

    # ── 2. Get embedder ──────────────────────────────────────────────────
    embedder: Embedder = get_embedder()

    # ── 3. Embed all questions (one batch) ───────────────────────────────
    print(f"[harness] Embedding {len(examples)} questions …")
    questions = [ex.question for ex in examples]
    q_embeddings = embedder.embed(questions)

    # ── 3b. QA reader/judge client (optional) ────────────────────────────
    qa_client = None
    if qa:
        if os.environ.get("OPENAI_API_KEY"):
            import openai  # lazy import
            qa_client = openai.OpenAI(api_key=os.environ["OPENAI_API_KEY"])
            print(
                f"[harness] QA enabled — reader={reader_model}, "
                f"judge={judge_model}"
            )
        else:
            print(
                "[harness] QA requested but OPENAI_API_KEY is unset — "
                "reporting retrieval metrics only."
            )

    # ── 4. Evaluate ──────────────────────────────────────────────────────
    # Each LongMemEval question has its OWN haystack, so each gets its own
    # isolated workspace (the faithful mapping: one workspace == one user's
    # memory). This exercises Brain's normal workspace-scoped search path and
    # prevents one question's sessions from polluting another's retrieval.
    per_example_hybrid: list[dict] = []
    per_example_temporal: list[dict] = []
    per_example_two_pass: list[dict] = []
    per_example_qa: list[dict] = []

    print(f"[harness] Running evaluation …\n")
    t0 = time.time()

    for i, (ex, emb) in enumerate(
        tqdm(zip(examples, q_embeddings), total=len(examples), desc="eval")
    ):
        ws = str(uuid.uuid4())
        await ensure_eval_workspace(ws)
        try:
            ingested = await ingest_examples([ex], ws, embedder, quiet=True)
            evidence_ids = {m.hyobject_id for m in ingested if m.is_evidence}
            async with session(ws) as conn:
                row = await _eval_example(
                    conn, ex, emb, embedder, ws,
                    evidence_ids=evidence_ids,
                    qa_client=qa_client,
                    reader_model=reader_model,
                    judge_model=judge_model,
                )
            per_example_hybrid.append(row["hybrid"])
            per_example_temporal.append(row["temporal"])
            per_example_two_pass.append(row["two_pass"])
            if "qa" in row:
                per_example_qa.append(row["qa"])
        finally:
            if purge_after:
                await purge_eval_workspace(ws)

    elapsed = time.time() - t0
    print(f"\n[harness] Eval complete in {elapsed:.1f}s")

    # ── 6. Aggregate ─────────────────────────────────────────────────────
    results = [
        aggregate("hybrid", per_example_hybrid),
        aggregate("temporal", per_example_temporal),
        aggregate("two_pass", per_example_two_pass),
    ]
    qa_result = (
        aggregate_qa(
            per_example_qa,
            reader_model=reader_model,
            judge_model=judge_model,
            retrieval_strategy="hybrid",
        )
        if per_example_qa
        else None
    )

    # ── 7. Save results ──────────────────────────────────────────────────
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    result_file = RESULTS_DIR / f"run_{ts}_n{len(examples)}.json"
    with result_file.open("w") as fh:
        json.dump(
            {
                "run_at": ts,
                "subset": dataset_subset,
                "isolation": "per-question-workspace",
                "shuffle": shuffle,
                "seed": seed,
                "n_examples": len(examples),
                "qa": asdict(qa_result) if qa_result else None,
                "results": [asdict(r) for r in results],
                "per_example": {
                    "hybrid": per_example_hybrid,
                    "temporal": per_example_temporal,
                    "two_pass": per_example_two_pass,
                    "qa": per_example_qa,
                },
            },
            fh,
            indent=2,
        )
    print(f"[harness] Results saved to {result_file}")
    # Per-question workspaces are purged inline in the eval loop (unless
    # --no-purge), so there is nothing left to clean up here.

    return results, qa_result
