"""
LongMemEval dataset loader.

Loads xiaowu0162/longmemeval from HuggingFace. Caches locally after first
download. Falls back to a synthetic 5-example mini dataset when the HF
package is unavailable (useful for CI without internet access).

Dataset structure per example:
    question_id : str
    question    : str
    answer      : str
    answer_span : str          — exact substring found in context
    sessions    : list[list[dict]]  — list of sessions, each a list of
                                     {role, content} turns
    category    : str          — e.g. "single_session_fact"
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

CACHE_DIR = Path(__file__).parent / ".cache"
HF_DATASET = "xiaowu0162/longmemeval"

# LongMemEval dates look like "2023/04/10 (Mon) 17:50". Strip the weekday and
# parse the rest. Returns a tz-aware UTC datetime, or None if unparseable.
_WEEKDAY_RE = re.compile(r"\s*\([A-Za-z]{3}\)\s*")


def parse_lme_date(value: str) -> datetime | None:
    if not value:
        return None
    cleaned = _WEEKDAY_RE.sub(" ", str(value)).strip()
    for fmt in ("%Y/%m/%d %H:%M", "%Y/%m/%d %H:%M:%S", "%Y/%m/%d"):
        try:
            return datetime.strptime(cleaned, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _role_label(role: str) -> str:
    # Real LongMemEval turns use roles "user"/"assistant"; the synthetic mini
    # set uses "human"/"assistant". Map both so user turns aren't mislabeled.
    return "User" if role in ("user", "human") else "Assistant"


def session_text(example: "LongMemExample", idx: int) -> str:
    """Reconstruct a session's full text with correct role labels."""
    lines = []
    for turn in example.sessions[idx]:
        lines.append(f"[{_role_label(turn.role)}]: {turn.content}")
    return "\n".join(lines)

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class Turn:
    role: str    # "human" | "assistant"
    content: str


@dataclass
class LongMemExample:
    question_id: str
    question: str
    answer: str
    answer_span: str
    sessions: list[list[Turn]]   # outer = sessions, inner = turns
    category: str = "unknown"
    # The "current" date the question is asked (LongMemEval question_date).
    question_date: str = ""
    # Per-session real timestamps (parallel to `sessions`). Essential for
    # temporal-reasoning questions and for the temporal retrieval strategy.
    session_dates: list[str] = field(default_factory=list)
    # Per-session ids (parallel to `sessions`) and the subset of them that
    # actually contain the answer — ground truth for evidence retrieval recall.
    session_ids: list[str] = field(default_factory=list)
    answer_session_ids: list[str] = field(default_factory=list)

    @property
    def is_abstention(self) -> bool:
        """LongMemEval marks unanswerable questions with an `_abs` id suffix."""
        return self.question_id.endswith("_abs")


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------


def _hf_row_to_example(row: dict[str, Any]) -> LongMemExample:
    # The real LongMemEval files store the conversation history under
    # "haystack_sessions" (list of sessions, each a list of {role, content}
    # turns). Older/synthetic shapes use "sessions" or "context".
    sessions_raw = (
        row.get("haystack_sessions")
        or row.get("sessions")
        or row.get("context")
        or []
    )
    # Normalize: some shapes store sessions as a single list of turn dicts.
    if sessions_raw and isinstance(sessions_raw[0], dict):
        sessions_raw = [sessions_raw]

    sessions: list[list[Turn]] = []
    for sess in sessions_raw:
        turns = [
            Turn(role=str(t.get("role", "user")), content=str(t.get("content", "")))
            for t in sess
            if isinstance(t, dict)
        ]
        sessions.append(turns)

    # Real LongMemEval has no separate span; the answer string is the target.
    answer_span = (
        row.get("answer_span")
        or row.get("evidence_span")
        or row.get("answer", "")
    )

    # Per-session metadata, kept parallel to `sessions`. The real files store
    # dates under "haystack_dates" and session ids under "haystack_session_ids";
    # "answer_session_ids" lists the evidence sessions.
    session_dates = [str(d) for d in (row.get("haystack_dates") or [])]
    session_ids = [str(s) for s in (row.get("haystack_session_ids") or [])]
    answer_session_ids = [str(s) for s in (row.get("answer_session_ids") or [])]

    return LongMemExample(
        question_id=str(row.get("question_id", row.get("id", ""))),
        question=str(row.get("question", "")),
        answer=str(row.get("answer", "")),
        answer_span=str(answer_span),
        sessions=sessions,
        # Real files label the type as "question_type" (e.g.
        # "single-session-user", "temporal-reasoning", "multi-session").
        category=str(row.get("question_type") or row.get("category") or "unknown"),
        question_date=str(row.get("question_date", "")),
        session_dates=session_dates,
        session_ids=session_ids,
        answer_session_ids=answer_session_ids,
    )


# Cache schema version — bump when the parsed shape changes so stale caches
# (e.g. ones written before dates/evidence ids were threaded through) are not
# silently reused.
_CACHE_VERSION = "v2"


def _load_all_examples(split: str, subset: str) -> list[LongMemExample]:
    """Download (and disk-cache) the full parsed example list for a subset."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    full_cache = CACHE_DIR / f"{subset}_{_CACHE_VERSION}_{split}_all.json"

    if full_cache.exists():
        with full_cache.open() as fh:
            raw = json.load(fh)
        return [_example_from_dict(r) for r in raw]

    # The real benchmark ships as extension-less JSON files (longmemeval_s,
    # longmemeval_m, longmemeval_oracle) in the HF *dataset* repo. `datasets.
    # load_dataset` keys off file extensions and cannot read them, so we
    # download the file directly and parse it ourselves.
    try:
        from huggingface_hub import hf_hub_download  # type: ignore
    except ImportError as exc:
        return _fallback_or_raise(
            f"huggingface_hub not installed ({exc})", subset
        )

    try:
        path = hf_hub_download(
            repo_id=HF_DATASET, filename=subset, repo_type="dataset"
        )
        with open(path) as fh:
            rows = json.load(fh)
    except Exception as exc:  # noqa: BLE001 — surface any load failure loudly
        return _fallback_or_raise(f"HF download/parse failed ({exc})", subset)

    if not isinstance(rows, list):
        return _fallback_or_raise(
            f"unexpected dataset shape: {type(rows).__name__}", subset
        )

    examples = [_hf_row_to_example(dict(r)) for r in rows]
    with full_cache.open("w") as fh:
        json.dump([_example_to_dict(e) for e in examples], fh)
    print(
        f"[dataset] Loaded {len(examples)} REAL examples from "
        f"{HF_DATASET}:{subset}."
    )
    return examples


def load_dataset(
    split: str = "test",
    max_examples: int = 200,
    subset: str = "longmemeval_s",   # _s = single-doc (faster), _m = multi
    shuffle: bool = False,
    seed: int = 0,
) -> list[LongMemExample]:
    """Load up to *max_examples* examples for *subset*.

    By default returns the first *max_examples* rows (the benchmark's native
    order). With *shuffle* the full set is deterministically shuffled with
    *seed* before slicing, yielding a representative cross-category sample
    (the oracle file is ordered by category, so the first N rows are all one
    type).
    """
    examples = _load_all_examples(split, subset)
    if not examples:
        return examples

    if shuffle:
        import random
        order = list(range(len(examples)))
        random.Random(seed).shuffle(order)
        examples = [examples[i] for i in order]

    selected = examples[:max_examples]
    print(
        f"[dataset] Selected {len(selected)} examples "
        f"({'seeded-shuffle' if shuffle else 'first-N'})."
    )
    return selected


def _fallback_or_raise(reason: str, subset: str) -> list[LongMemExample]:
    """Refuse to silently benchmark on synthetic data.

    Benchmarking on the synthetic mini set and reporting it as a LongMemEval
    score would be misleading. Only fall back when the caller explicitly opts
    in via LONGMEMEVAL_ALLOW_SYNTHETIC=1 (e.g. an offline CI smoke test);
    otherwise fail loudly so a real run never reports a fake number.
    """
    if os.environ.get("LONGMEMEVAL_ALLOW_SYNTHETIC") == "1":
        print(
            f"[dataset] WARNING: {reason}. "
            "LONGMEMEVAL_ALLOW_SYNTHETIC=1 set — using SYNTHETIC mini set. "
            "Do NOT report this as a LongMemEval score."
        )
        return _synthetic_mini()
    raise RuntimeError(
        f"Could not load the real LongMemEval dataset ({HF_DATASET}:{subset}): "
        f"{reason}. Refusing to silently fall back to synthetic data. "
        "Set LONGMEMEVAL_ALLOW_SYNTHETIC=1 only for offline smoke tests."
    )


# ---------------------------------------------------------------------------
# Serialization helpers
# ---------------------------------------------------------------------------


def _example_to_dict(e: LongMemExample) -> dict:
    return {
        "question_id": e.question_id,
        "question": e.question,
        "answer": e.answer,
        "answer_span": e.answer_span,
        "category": e.category,
        "question_date": e.question_date,
        "session_dates": e.session_dates,
        "session_ids": e.session_ids,
        "answer_session_ids": e.answer_session_ids,
        "sessions": [
            [{"role": t.role, "content": t.content} for t in sess]
            for sess in e.sessions
        ],
    }


def _example_from_dict(d: dict) -> LongMemExample:
    sessions = [
        [Turn(role=t["role"], content=t["content"]) for t in sess]
        for sess in d["sessions"]
    ]
    return LongMemExample(
        question_id=d["question_id"],
        question=d["question"],
        answer=d["answer"],
        answer_span=d["answer_span"],
        category=d["category"],
        sessions=sessions,
        # `.get` keeps old cache files (written before these fields existed)
        # loadable; a stale cache simply loses the date/evidence metadata.
        question_date=d.get("question_date", ""),
        session_dates=d.get("session_dates", []),
        session_ids=d.get("session_ids", []),
        answer_session_ids=d.get("answer_session_ids", []),
    )


# ---------------------------------------------------------------------------
# Synthetic mini dataset (used when HF is unavailable)
# ---------------------------------------------------------------------------


def _synthetic_mini() -> list[LongMemExample]:
    """Five hand-crafted examples that exercise different recall patterns."""
    examples = [
        LongMemExample(
            question_id="syn-001",
            question="What is Alice's favourite programming language?",
            answer="Python",
            answer_span="Python is my favourite language",
            sessions=[[
                Turn("human", "Hi, I'm Alice."),
                Turn("assistant", "Hello Alice!"),
                Turn("human", "Python is my favourite language. I use it daily."),
                Turn("assistant", "Great choice!"),
            ]],
            category="single_session_fact",
        ),
        LongMemExample(
            question_id="syn-002",
            question="Where did Bob grow up?",
            answer="Tokyo",
            answer_span="I grew up in Tokyo",
            sessions=[[
                Turn("human", "I grew up in Tokyo and moved to Berlin in 2015."),
                Turn("assistant", "Tokyo is a wonderful city."),
            ]],
            category="single_session_fact",
        ),
        LongMemExample(
            question_id="syn-003",
            question="What project did the team finish last Friday?",
            answer="Project Phoenix",
            answer_span="Project Phoenix was completed on Friday",
            sessions=[[
                Turn("human", "Quick update: Project Phoenix was completed on Friday."),
                Turn("assistant", "Congratulations on shipping!"),
                Turn("human", "Thanks! The client is happy."),
            ]],
            category="temporal_fact",
        ),
        LongMemExample(
            question_id="syn-004",
            question="What medication does Carol take every morning?",
            answer="metformin",
            answer_span="I take metformin every morning",
            sessions=[
                [
                    Turn("human", "Quick question about my health routine."),
                    Turn("assistant", "Sure, go ahead."),
                ],
                [
                    Turn("human", "I take metformin every morning for my diabetes."),
                    Turn("assistant", "Noted. Any side effects?"),
                ],
            ],
            category="multi_session_fact",
        ),
        LongMemExample(
            question_id="syn-005",
            question="What sport does Dave play competitively?",
            answer="chess",
            answer_span="I play chess competitively",
            sessions=[[
                Turn("human", "People are surprised but I play chess competitively."),
                Turn("assistant", "What's your rating?"),
                Turn("human", "Around 1800 ELO."),
            ]],
            category="single_session_fact",
        ),
    ]
    return examples
