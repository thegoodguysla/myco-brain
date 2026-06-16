"""
Brain search harness for evaluation.

Mirrors the scoring logic in mcp-server/src/tools/search.ts:
  1. Over-fetch 3× candidates via pgvector cosine similarity
  2. BM25 re-rank over the candidate set
  3. Closet (entity) boost
  4. Final score: 0.6 * vec_sim + 0.4 * bm25_norm + closet_boost

Additionally exposes:
  - temporal_search  — date_desc sort (recency bias)
  - two_pass_search  — pass 1: hybrid; pass 2: entity-expand + re-search

All functions are async and take an open psycopg connection.
"""
from __future__ import annotations

import math
import re
from collections import defaultdict
from dataclasses import dataclass

import psycopg

# Weights — match search.ts constants
VEC_WEIGHT = 0.6
BM25_WEIGHT = 0.4
CLOSET_BOOST_RANKS = 3       # top-3 entity hits get a bonus
CLOSET_BOOST_VALUE = 0.15
OVERFETCH_FACTOR = 3


@dataclass
class SearchHit:
    chunk_id: str
    hyobject_id: str
    hyobject_name: str
    chunk_index: int
    text: str
    score: float
    created_at: str


# ---------------------------------------------------------------------------
# BM25 utilities (port of bm25.ts)
# ---------------------------------------------------------------------------

_STOP = frozenset(
    "a an the is are was were be been being have has had do does did "
    "will would could should may might shall can i you he she it we they "
    "and or but not of in on at to for with by from".split()
)


def _tokenize(text: str | bytes) -> list[str]:
    # Defensive: a DB connection using a non-UTF-8 client encoding (e.g.
    # SQL_ASCII) can hand back text columns as `bytes`. Coerce to str so the
    # regex below never raises "cannot use a string pattern on a bytes-like
    # object". db.py forces UTF-8, so this is belt-and-suspenders.
    if isinstance(text, (bytes, bytearray)):
        text = bytes(text).decode("utf-8", errors="replace")
    return [
        w.lower()
        for w in re.findall(r"[a-z0-9]+", text.lower())
        if w not in _STOP and len(w) > 1
    ]


def _bm25_scores(query_tokens: list[str], docs: list[str]) -> list[float]:
    """Lucene-style BM25 over a candidate doc set."""
    k1, b = 1.2, 0.75
    if not docs or not query_tokens:
        return [0.0] * len(docs)

    tokenized = [_tokenize(d) for d in docs]
    avg_dl = sum(len(t) for t in tokenized) / len(tokenized) or 1.0
    N = len(docs)

    # IDF per query term (candidate-set denominator)
    df: dict[str, int] = defaultdict(int)
    for toks in tokenized:
        tok_set = set(toks)
        for q in query_tokens:
            if q in tok_set:
                df[q] += 1

    scores: list[float] = []
    for toks in tokenized:
        dl = len(toks) or 1
        freq: dict[str, int] = defaultdict(int)
        for t in toks:
            freq[t] += 1

        score = 0.0
        for q in query_tokens:
            f = freq.get(q, 0)
            if f == 0:
                continue
            idf = math.log((N - df[q] + 0.5) / (df[q] + 0.5) + 1)
            tf = (f * (k1 + 1)) / (f + k1 * (1 - b + b * dl / avg_dl))
            score += idf * tf
        scores.append(score)
    return scores


def _to_str(value) -> str:
    """Coerce a possibly-bytes DB value to str (see _tokenize for why)."""
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).decode("utf-8", errors="replace")
    return "" if value is None else str(value)


def _min_max_normalize(values: list[float]) -> list[float]:
    mn, mx = min(values), max(values)
    span = mx - mn
    if span == 0:
        return [0.0] * len(values)
    return [(v - mn) / span for v in values]


# ---------------------------------------------------------------------------
# Core search functions
# ---------------------------------------------------------------------------


async def hybrid_search(
    conn: psycopg.AsyncConnection,
    query: str,
    embedding: list[float],
    limit: int = 20,
    workspace_id: str | None = None,
) -> list[SearchHit]:
    """
    Hybrid search: pgvector → BM25 re-rank → closet boost.
    Mirrors hybridSearch() in search.ts.
    """
    candidate_limit = limit * OVERFETCH_FACTOR
    vec_str = f"[{','.join(str(x) for x in embedding)}]"

    ws_filter = ""
    params: list = [vec_str, candidate_limit]
    if workspace_id:
        ws_filter = "AND h.workspace_id = %s"
        params.insert(1, workspace_id)
        params[2] = candidate_limit  # adjust index after insert

    # Re-build params cleanly
    params = []
    conditions = ["h.processing_state = 'done'"]
    params.append(vec_str)
    vec_idx = len(params)
    if workspace_id:
        params.append(workspace_id)
        conditions.append(f"h.workspace_id = %s")

    params.append(candidate_limit)
    limit_idx = len(params)

    where = " AND ".join(conditions)

    sql = f"""
        SELECT
            c.chunk_id,
            c.hyobject_id,
            h.name AS hyobject_name,
            c.chunk_index,
            c.text,
            1 - (c.embedding <=> %s::vector) AS vec_sim,
            h.created_at
        FROM chunks c
        JOIN hyobjects h ON h.hyobject_id = c.hyobject_id
        WHERE {where}
        ORDER BY c.embedding <=> %s::vector
        LIMIT %s
    """

    # Rebuild with correct param positions
    params2 = [vec_str]
    conds2 = ["h.processing_state = 'done'"]
    if workspace_id:
        params2.append(workspace_id)
        conds2.append("h.workspace_id = %s")
    params2.append(vec_str)  # second vec ref for ORDER BY
    params2.append(candidate_limit)

    where2 = " AND ".join(conds2)
    sql2 = f"""
        SELECT
            c.chunk_id,
            c.hyobject_id,
            h.name AS hyobject_name,
            c.chunk_index,
            c.text,
            1 - (c.embedding <=> %s::vector) AS vec_sim,
            h.created_at
        FROM chunks c
        JOIN hyobjects h ON h.hyobject_id = c.hyobject_id
        WHERE {where2}
        ORDER BY c.embedding <=> %s::vector
        LIMIT %s
    """

    rows = await (await conn.execute(sql2, params2)).fetchall()
    if not rows:
        return []

    # BM25 re-rank
    query_tokens = _tokenize(query)
    docs = [r["text"] for r in rows]
    bm25_raw = _bm25_scores(query_tokens, docs)
    bm25_norm = _min_max_normalize(bm25_raw) if bm25_raw else bm25_raw
    vec_sims = [float(r["vec_sim"]) for r in rows]
    vec_norm = _min_max_normalize(vec_sims) if vec_sims else vec_sims

    # Closet boost: rank-based bonus for top entity-matching chunks
    # (simplified: boost chunks whose text contains the most query tokens)
    token_set = set(query_tokens)
    overlap = [
        len(token_set & set(_tokenize(r["text"]))) for r in rows
    ]
    ranked_by_overlap = sorted(range(len(overlap)), key=lambda i: -overlap[i])
    boost = [0.0] * len(rows)
    for rank_pos, idx in enumerate(ranked_by_overlap[:CLOSET_BOOST_RANKS]):
        boost[idx] = CLOSET_BOOST_VALUE * (1 - rank_pos / CLOSET_BOOST_RANKS)

    hits: list[tuple[float, SearchHit]] = []
    for i, row in enumerate(rows):
        final_score = (
            VEC_WEIGHT * vec_norm[i]
            + BM25_WEIGHT * bm25_norm[i]
            + boost[i]
        )
        hits.append((
            final_score,
            SearchHit(
                chunk_id=str(row["chunk_id"]),
                hyobject_id=str(row["hyobject_id"]),
                hyobject_name=_to_str(row["hyobject_name"]),
                chunk_index=row["chunk_index"],
                text=_to_str(row["text"]),
                score=final_score,
                created_at=str(row["created_at"]),
            ),
        ))

    hits.sort(key=lambda x: -x[0])
    return [h for _, h in hits[:limit]]


async def temporal_search(
    conn: psycopg.AsyncConnection,
    query: str,
    embedding: list[float],
    limit: int = 20,
    workspace_id: str | None = None,
) -> list[SearchHit]:
    """
    Recency-biased search: re-ranks hybrid results by a combination of
    relevance score and recency (date_desc), simulating temporal boost.

    Formula: temporal_score = 0.7 * relevance + 0.3 * recency_rank_norm

    This mirrors the production RecencyReranker (mcp-server/src/reranker.ts,
    strategy="recency") — identical formula — so the "temporal" row of this
    benchmark reflects that shipped, keyless feature: brain_search with
    reranker="recency".
    """
    hits = await hybrid_search(conn, query, embedding, limit * 2, workspace_id)
    if not hits:
        return []

    # Assign recency rank (0 = most recent)
    sorted_by_date = sorted(hits, key=lambda h: h.created_at, reverse=True)
    recency_rank = {h.chunk_id: i for i, h in enumerate(sorted_by_date)}
    n = len(hits)

    scored: list[tuple[float, SearchHit]] = []
    for h in hits:
        recency_norm = 1.0 - recency_rank[h.chunk_id] / n
        final = 0.7 * h.score + 0.3 * recency_norm
        scored.append((final, SearchHit(**{**h.__dict__, "score": final})))

    scored.sort(key=lambda x: -x[0])
    return [h for _, h in scored[:limit]]


async def two_pass_search(
    conn: psycopg.AsyncConnection,
    query: str,
    embedding: list[float],
    embedder,  # Embedder instance
    limit: int = 20,
    workspace_id: str | None = None,
) -> list[SearchHit]:
    """
    Two-pass retrieval:
      Pass 1 — Hybrid search for top 3×limit candidates.
      Pass 2 — Extract key terms from the top-5 candidates, build an
               expanded query, re-embed, search again for top limit.
               Merge and deduplicate by score (max).

    This simulates pseudo-relevance feedback to improve recall on
    under-specified questions.
    """
    # Pass 1
    pass1 = await hybrid_search(
        conn, query, embedding, limit * 3, workspace_id
    )

    # Extract key terms from top-5 results for query expansion
    top5_text = " ".join(h.text for h in pass1[:5])
    top5_tokens = _tokenize(top5_text)
    # Take the 10 most frequent non-stopword tokens
    freq: dict[str, int] = defaultdict(int)
    for t in top5_tokens:
        freq[t] += 1
    expansion_terms = " ".join(
        t for t, _ in sorted(freq.items(), key=lambda x: -x[1])[:10]
    )
    expanded_query = f"{query} {expansion_terms}"

    # Re-embed expanded query
    expanded_emb = embedder.embed([expanded_query])[0]

    # Pass 2
    pass2 = await hybrid_search(
        conn, expanded_query, expanded_emb, limit * 2, workspace_id
    )

    # Merge: keep max score per chunk_id
    by_id: dict[str, SearchHit] = {}
    for h in pass1 + pass2:
        if h.chunk_id not in by_id or h.score > by_id[h.chunk_id].score:
            by_id[h.chunk_id] = h

    merged = sorted(by_id.values(), key=lambda h: -h.score)
    return merged[:limit]
