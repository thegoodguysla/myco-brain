"""
End-to-end QA accuracy for LongMemEval — the benchmark's headline metric.

On the *oracle* subset the haystack contains only the evidence sessions, so
retrieval is near-trivial; what oracle actually measures is whether a system
can *answer* the question given the right memories. Substring/recall metrics
can't capture that (only ~51% of oracle answers even appear verbatim in the
haystack, and temporal-reasoning answers like "7 days" are computed, never
stated). So we evaluate the real thing:

  1. Retrieve top-k chunks with Brain's hybrid search (done by the harness).
  2. A *reader* LLM answers the question using only that retrieved context,
     with each memory labelled by its real date so temporal questions are
     answerable.
  3. A *judge* LLM decides whether the answer is correct vs. the gold answer.

The judge prompts are a faithful reimplementation of the official LongMemEval
evaluator (github.com/xiaowu0162/LongMemEval, evaluate_qa.py), including the
category-specific variants for temporal-reasoning, knowledge-update,
single-session-preference, and abstention (`_abs`) questions.
"""
from __future__ import annotations

import os

from .dataset import LongMemExample, session_text
from .search import SearchHit

# Models are configurable so the eval can trade cost for fidelity. The official
# harness judges with gpt-4o; we default to gpt-4o-mini (much cheaper, and a
# capable judge for this yes/no task) and document the choice in the README.
DEFAULT_READER_MODEL = os.environ.get("LONGMEMEVAL_QA_MODEL", "gpt-4o-mini")
DEFAULT_JUDGE_MODEL = os.environ.get("LONGMEMEVAL_JUDGE_MODEL", "gpt-4o-mini")

# How many distinct retrieved sessions to hand the reader. LongMemEval sessions
# are whole multi-topic conversations (often 15-20+ chunks each), so chunk-level
# context drops facts the answer depends on. We retrieve at chunk granularity
# (that is Brain's job and what the Ev@k metric scores) but read the *full* text
# of each surfaced session — the standard memory-benchmark reader setup.
READER_MAX_SESSIONS = 6


def _session_idx_from_name(name: str) -> int | None:
    """Parse the session index out of an `eval:{id}:session:{idx}` hyobject name."""
    parts = (name or "").split(":")
    if len(parts) >= 2 and parts[-2] == "session":
        try:
            return int(parts[-1])
        except ValueError:
            return None
    return None


def _build_context(
    example: LongMemExample,
    hits: list[SearchHit],
    max_sessions: int = READER_MAX_SESSIONS,
) -> str:
    """Render the top retrieved sessions (full text, deduped, rank order)."""
    blocks: list[str] = []
    seen: set[int] = set()
    for h in hits:
        idx = _session_idx_from_name(h.hyobject_name)
        if idx is None or idx in seen or idx >= len(example.sessions):
            # Fall back to the raw chunk when we can't map back to a session.
            if idx is None:
                date = (h.created_at or "").split("+")[0].strip()
                blocks.append(f"[memory {len(blocks)+1} | {date}]\n{h.text}")
            if len(blocks) >= max_sessions:
                break
            continue
        seen.add(idx)
        date = example.session_dates[idx] if idx < len(example.session_dates) else ""
        blocks.append(
            f"[memory {len(blocks)+1} | {date}]\n{session_text(example, idx)}"
        )
        if len(blocks) >= max_sessions:
            break
    return "\n\n".join(blocks) if blocks else "(no relevant memories found)"


def generate_answer(
    client,
    example: LongMemExample,
    hits: list[SearchHit],
    model: str = DEFAULT_READER_MODEL,
) -> str:
    """Have the reader LLM answer the question from retrieved context only."""
    context = _build_context(example, hits)
    system = (
        "You are a helpful assistant answering questions about a user based on "
        "their past conversations. Use ONLY the memories provided below; each "
        "is labelled with the date it occurred. "
        f"Today's date is {example.question_date or 'unknown'}. "
        "Reason about dates and durations using these labels. Answer concisely. "
        "If the memories do not contain enough information to answer, reply "
        "exactly: I don't know."
    )
    user = f"# Memories\n{context}\n\n# Question\n{example.question}"
    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        temperature=0.0,
        max_tokens=256,
    )
    answer = (resp.choices[0].message.content or "").strip()
    # Token cost of answering from memory: prompt tokens ≈ the retrieved
    # memory payload (the comparable "tokens per query" efficiency metric);
    # total adds the answer itself.
    usage = getattr(resp, "usage", None)
    tokens = {
        "prompt_tokens": getattr(usage, "prompt_tokens", 0) or 0,
        "total_tokens": getattr(usage, "total_tokens", 0) or 0,
    }
    return answer, tokens


# ---------------------------------------------------------------------------
# Judge — faithful port of LongMemEval evaluate_qa.py get_anscheck_prompt()
# ---------------------------------------------------------------------------


def _judge_prompt(example: LongMemExample, response: str) -> str:
    q, a, r = example.question, example.answer, response
    if example.is_abstention:
        return (
            "I will give you an unanswerable question, an explanation, and a "
            "response from a model. Please answer yes if the model correctly "
            "identifies the question as unanswerable. The model could say that "
            "the information is incomplete, or some other information is given "
            "but the asked information is not.\n\n"
            f"Question: {q}\nExplanation: {a}\nModel Response: {r}\n\n"
            "Does the model correctly identify the question as unanswerable? "
            "Answer yes or no only."
        )
    cat = example.category
    if cat == "temporal-reasoning":
        return (
            "I will give you a question, a correct answer, and a response from a "
            "model. Please answer yes if the response contains the correct "
            "answer. Otherwise, answer no. If the response is equivalent to the "
            "correct answer or contains all the intermediate steps to get the "
            "correct answer, you should also answer yes. If the response only "
            "contains a subset of the information required by the answer, answer "
            "no. In addition, do not penalize off-by-one errors for the number "
            "of days. If the question asks for the number of days/weeks/months, "
            "etc., and the model makes off-by-one errors (e.g., predicting 19 "
            "days when the answer is 20 days), the model's response is still "
            "correct.\n\n"
            f"Question: {q}\nCorrect Answer: {a}\nModel Response: {r}\n\n"
            "Is the model response correct? Answer yes or no only."
        )
    if cat == "knowledge-update":
        return (
            "I will give you a question, a correct answer, and a response from a "
            "model. Please answer yes if the response contains the correct "
            "answer. Otherwise, answer no. If the response contains some "
            "previous information along with an updated answer, the response "
            "should be considered as correct as long as the updated answer is "
            "the required answer.\n\n"
            f"Question: {q}\nCorrect Answer: {a}\nModel Response: {r}\n\n"
            "Is the model response correct? Answer yes or no only."
        )
    if cat == "single-session-preference":
        return (
            "I will give you a question, a rubric for desired personalized "
            "response, and a response from a model. Please answer yes if the "
            "response satisfies the desired response. Otherwise, answer no. The "
            "model does not need to reflect all the points in the rubric. The "
            "response is correct as long as it recalls and utilizes the user's "
            "personal information correctly.\n\n"
            f"Question: {q}\nRubric: {a}\nModel Response: {r}\n\n"
            "Is the model response correct? Answer yes or no only."
        )
    # default: single-session-user, single-session-assistant, multi-session
    return (
        "I will give you a question, a correct answer, and a response from a "
        "model. Please answer yes if the response contains the correct answer. "
        "Otherwise, answer no. If the response is equivalent to the correct "
        "answer or contains all the intermediate steps to get the correct "
        "answer, you should also answer yes. If the response only contains a "
        "subset of the information required by the answer, answer no.\n\n"
        f"Question: {q}\nCorrect Answer: {a}\nModel Response: {r}\n\n"
        "Is the model response correct? Answer yes or no only."
    )


def judge_answer(
    client,
    example: LongMemExample,
    response: str,
    model: str = DEFAULT_JUDGE_MODEL,
) -> bool:
    """Return True if the judge LLM rules the response correct."""
    prompt = _judge_prompt(example, response)
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.0,
        max_tokens=5,
    )
    verdict = (resp.choices[0].message.content or "").strip().lower()
    return verdict.startswith("yes")
