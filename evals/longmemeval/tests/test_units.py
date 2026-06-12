"""
Offline unit tests for the LongMemEval harness.

These cover the pure logic — date parsing, dataset-row normalization,
bytes-tolerant tokenization, judge-prompt selection, and metric aggregation —
with NO database, network, or LLM access, so they run in CI. The live
end-to-end accuracy run is driven separately via `python -m evals.longmemeval.run`.

Run from the repo root:  pytest evals/longmemeval/tests
"""
from __future__ import annotations

from datetime import datetime, timezone

from evals.longmemeval.dataset import (
    LongMemExample,
    _hf_row_to_example,
    parse_lme_date,
)
from evals.longmemeval.metrics import (
    aggregate_qa,
    evidence_recall_at_k,
    recall_at_k,
)
from evals.longmemeval.qa import _judge_prompt
from evals.longmemeval.search import SearchHit, _tokenize, _to_str


# ── date parsing ─────────────────────────────────────────────────────────


def test_parse_lme_date_with_weekday():
    dt = parse_lme_date("2023/04/10 (Mon) 17:50")
    assert dt == datetime(2023, 4, 10, 17, 50, tzinfo=timezone.utc)


def test_parse_lme_date_date_only_and_empty():
    assert parse_lme_date("2023/04/10") == datetime(
        2023, 4, 10, tzinfo=timezone.utc
    )
    assert parse_lme_date("") is None
    assert parse_lme_date("not a date") is None


# ── dataset row normalization ────────────────────────────────────────────


def test_hf_row_extracts_dates_and_evidence():
    row = {
        "question_id": "gpt4_abc",
        "question_type": "temporal-reasoning",
        "question": "When?",
        "answer": "Tuesday",
        "question_date": "2023/04/10 (Mon) 23:07",
        "haystack_dates": ["2023/04/10 (Mon) 17:50", "2023/04/09 (Sun) 10:00"],
        "haystack_session_ids": ["s_2", "s_1"],
        "answer_session_ids": ["s_2"],
        "haystack_sessions": [
            [{"role": "user", "content": "a"}],
            [{"role": "assistant", "content": "b"}],
        ],
    }
    ex = _hf_row_to_example(row)
    assert ex.category == "temporal-reasoning"
    assert ex.question_date == "2023/04/10 (Mon) 23:07"
    assert ex.session_dates == ["2023/04/10 (Mon) 17:50", "2023/04/09 (Sun) 10:00"]
    assert ex.session_ids == ["s_2", "s_1"]
    assert ex.answer_session_ids == ["s_2"]
    assert len(ex.sessions) == 2 and ex.sessions[0][0].content == "a"
    assert ex.is_abstention is False


def test_is_abstention_suffix():
    ex = LongMemExample("q_abs", "q", "a", "a", sessions=[])
    assert ex.is_abstention is True


# ── bytes-tolerant tokenization (the SQL_ASCII bug) ──────────────────────


def test_tokenize_handles_bytes():
    # A SQL_ASCII connection hands back text as bytes; the tokenizer must cope.
    assert _tokenize(b"Hello World GPS") == _tokenize("Hello World GPS")
    assert "gps" in _tokenize(b"the GPS system")


def test_to_str_coerces():
    assert _to_str(b"abc") == "abc"
    assert _to_str(None) == ""
    assert _to_str(123) == "123"


# ── judge prompt selection ───────────────────────────────────────────────


def _ex(category="multi-session", qid="q1"):
    return LongMemExample(qid, "the question?", "the gold", "the gold",
                          sessions=[], category=category)


def test_judge_prompt_variants():
    assert "off-by-one" in _judge_prompt(_ex("temporal-reasoning"), "r")
    assert "updated answer" in _judge_prompt(_ex("knowledge-update"), "r")
    assert "Rubric" in _judge_prompt(_ex("single-session-preference"), "r")
    assert "unanswerable" in _judge_prompt(_ex(qid="q_abs"), "r")
    # default category
    base = _judge_prompt(_ex("multi-session"), "r")
    assert "contains the correct answer" in base and "off-by-one" not in base


# ── metrics ──────────────────────────────────────────────────────────────


def _hit(hyobject_id="h1", text="some text"):
    return SearchHit("c", hyobject_id, "name", 0, text, 0.5, "2023-04-10")


def test_evidence_recall_at_k():
    hits = [_hit("h1"), _hit("h2"), _hit("h3")]
    assert evidence_recall_at_k(hits, {"h2"}, 5) is True
    assert evidence_recall_at_k(hits, {"h2"}, 1) is False  # h2 is rank 2
    assert evidence_recall_at_k(hits, set(), 5) is False


def test_lexical_recall_at_k():
    hits = [_hit(text="I take metformin every morning")]
    assert recall_at_k(hits, "metformin", 1) is True
    assert recall_at_k(hits, "insulin", 1) is False


def test_aggregate_qa():
    rows = [
        {"correct": True, "category": "multi-session"},
        {"correct": False, "category": "multi-session"},
        {"correct": True, "category": "temporal-reasoning"},
    ]
    res = aggregate_qa(rows, reader_model="m", judge_model="j",
                       retrieval_strategy="hybrid")
    assert res.n == 3
    assert abs(res.accuracy - 2 / 3) < 1e-9
    assert res.by_category["multi-session"]["accuracy"] == 0.5
    assert res.reader_model == "m"
