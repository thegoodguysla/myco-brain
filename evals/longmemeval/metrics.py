"""
Evaluation metrics for LongMemEval.

Implements:
  - QA accuracy           — the headline metric (judged end-to-end; see qa.py)
  - Evidence recall (Ev@K) — did the top-K chunks include a labelled evidence
                             session? The honest retrieval metric.
  - Recall@K / EM / F1     — verbatim-substring proxies, reported as diagnostics
                             only (they under-count heavily on this benchmark).

R@K / Ev@K definition used here:
    A hit is counted if *any* of the top-K chunks matches — by answer_span
    substring (R@K) or by belonging to an evidence session (Ev@K).
"""
from __future__ import annotations

import re
import string
from dataclasses import dataclass, field

from .search import SearchHit


def _normalize(text: str) -> str:
    text = text.lower()
    text = text.translate(str.maketrans("", "", string.punctuation))
    return " ".join(text.split())


def _token_f1(pred: str, gold: str) -> float:
    pred_tokens = _normalize(pred).split()
    gold_tokens = _normalize(gold).split()
    if not pred_tokens or not gold_tokens:
        return 0.0
    common = set(pred_tokens) & set(gold_tokens)
    if not common:
        return 0.0
    precision = len(common) / len(pred_tokens)
    recall = len(common) / len(gold_tokens)
    return 2 * precision * recall / (precision + recall)


def recall_at_k(hits: list[SearchHit], answer_span: str, k: int) -> bool:
    """True if answer_span appears (case-insensitive) in any of the top-K chunks.

    This is a *lexical* proxy: it only fires when the gold answer is a verbatim
    substring of a retrieved chunk. On LongMemEval that under-counts heavily
    (paraphrased/computed answers), so it is reported as a diagnostic only —
    `evidence_recall_at_k` is the honest retrieval metric and `qa_accuracy`
    (see qa.py) is the headline.
    """
    norm_answer = _normalize(answer_span)
    for hit in hits[:k]:
        if norm_answer in _normalize(hit.text):
            return True
    return False


def evidence_recall_at_k(
    hits: list[SearchHit], evidence_hyobject_ids: set[str], k: int
) -> bool:
    """True if any of the top-K chunks comes from a labelled evidence session.

    Uses LongMemEval's `answer_session_ids` ground truth (mapped to ingested
    hyobject ids by the harness). This is the correct retrieval metric: did we
    surface a memory that actually contains the answer?
    """
    if not evidence_hyobject_ids:
        return False
    for hit in hits[:k]:
        if hit.hyobject_id in evidence_hyobject_ids:
            return True
    return False


def exact_match(hits: list[SearchHit], answer: str) -> bool:
    """True if the top chunk contains the normalized answer string."""
    if not hits:
        return False
    norm_answer = _normalize(answer)
    return norm_answer in _normalize(hits[0].text)


def top_f1(hits: list[SearchHit], answer_span: str) -> float:
    """Token F1 between the top chunk and the answer span."""
    if not hits:
        return 0.0
    return _token_f1(hits[0].text, answer_span)


# ---------------------------------------------------------------------------
# Aggregate result containers
# ---------------------------------------------------------------------------


@dataclass
class StrategyResult:
    name: str
    r_at_1: float = 0.0
    r_at_5: float = 0.0
    r_at_10: float = 0.0
    em: float = 0.0
    f1: float = 0.0
    # Evidence retrieval recall (vs answer_session_ids) — the honest metric.
    ev_at_1: float = 0.0
    ev_at_5: float = 0.0
    ev_at_10: float = 0.0
    n: int = 0
    # Per-category breakdown
    by_category: dict[str, dict[str, float]] = field(default_factory=dict)


@dataclass
class QAResult:
    """End-to-end QA accuracy (the headline LongMemEval metric)."""
    name: str = "qa_accuracy"
    accuracy: float = 0.0
    n: int = 0
    reader_model: str = ""
    judge_model: str = ""
    retrieval_strategy: str = ""
    by_category: dict[str, dict[str, float]] = field(default_factory=dict)


def aggregate(
    name: str,
    per_example: list[dict],  # {r1,r5,r10,em,f1,ev1,ev5,ev10,category}
) -> StrategyResult:
    n = len(per_example)
    if n == 0:
        return StrategyResult(name=name)

    def avg(key: str) -> float:
        return sum(e.get(key, 0.0) for e in per_example) / n

    result = StrategyResult(
        name=name,
        r_at_1=avg("r1"),
        r_at_5=avg("r5"),
        r_at_10=avg("r10"),
        em=avg("em"),
        f1=avg("f1"),
        ev_at_1=avg("ev1"),
        ev_at_5=avg("ev5"),
        ev_at_10=avg("ev10"),
        n=n,
    )

    # Per-category
    categories: dict[str, list[dict]] = {}
    for e in per_example:
        cat = e.get("category", "unknown")
        categories.setdefault(cat, []).append(e)

    for cat, rows in categories.items():
        nc = len(rows)
        result.by_category[cat] = {
            "r_at_1": sum(r["r1"] for r in rows) / nc,
            "r_at_5": sum(r["r5"] for r in rows) / nc,
            "r_at_10": sum(r["r10"] for r in rows) / nc,
            "ev_at_5": sum(r.get("ev5", 0.0) for r in rows) / nc,
            "n": nc,
        }

    return result


def aggregate_qa(
    per_example: list[dict],  # {correct: bool, category: str}
    reader_model: str = "",
    judge_model: str = "",
    retrieval_strategy: str = "",
) -> QAResult:
    n = len(per_example)
    if n == 0:
        return QAResult(reader_model=reader_model, judge_model=judge_model,
                        retrieval_strategy=retrieval_strategy)
    accuracy = sum(1 for e in per_example if e.get("correct")) / n

    by_category: dict[str, dict[str, float]] = {}
    cats: dict[str, list[dict]] = {}
    for e in per_example:
        cats.setdefault(e.get("category", "unknown"), []).append(e)
    for cat, rows in cats.items():
        nc = len(rows)
        by_category[cat] = {
            "accuracy": sum(1 for r in rows if r.get("correct")) / nc,
            "n": nc,
        }

    return QAResult(
        accuracy=accuracy,
        n=n,
        reader_model=reader_model,
        judge_model=judge_model,
        retrieval_strategy=retrieval_strategy,
        by_category=by_category,
    )


def format_report(
    results: list[StrategyResult],
    qa: "QAResult | None" = None,
) -> str:
    lines = []
    lines.append("=" * 72)
    lines.append("LongMemEval Benchmark Results")
    lines.append("=" * 72)

    # ── Headline: end-to-end QA accuracy ─────────────────────────────────
    if qa is not None and qa.n:
        lines.append(
            f"QA accuracy: {qa.accuracy:.1%}  (n={qa.n}, "
            f"retrieval={qa.retrieval_strategy}, reader={qa.reader_model}, "
            f"judge={qa.judge_model})"
        )
        if qa.by_category:
            lines.append("  by category:")
            for cat, stats in sorted(qa.by_category.items()):
                lines.append(
                    f"    {cat:<28} {stats['accuracy']:>6.1%}  (n={int(stats['n'])})"
                )
        lines.append("-" * 72)

    # ── Retrieval diagnostics ────────────────────────────────────────────
    lines.append("Retrieval (Ev@k = evidence recall; R@k = lexical proxy):")
    lines.append(
        f"{'Strategy':<14} {'Ev@1':>6} {'Ev@5':>6} {'Ev@10':>6} "
        f"{'R@1':>6} {'R@5':>6} {'R@10':>6} {'F1':>6} {'n':>5}"
    )
    lines.append("-" * 72)
    for r in results:
        lines.append(
            f"{r.name:<14} {r.ev_at_1:>6.1%} {r.ev_at_5:>6.1%} {r.ev_at_10:>6.1%} "
            f"{r.r_at_1:>6.1%} {r.r_at_5:>6.1%} {r.r_at_10:>6.1%} {r.f1:>6.1%} {r.n:>5}"
        )
    lines.append("=" * 72)

    return "\n".join(lines)
