"""
Ingest LongMemEval conversation sessions into Brain.

Each (example_id, session_index) pair becomes a single hyobject of type 4
(Note). The hyobject name encodes the example + session so we can map
retrieved chunks back to ground-truth examples.

Text stored per hyobject: concatenated turns formatted as
    [Human]: <text>
    [Assistant]: <text>

The hyobject's metadata JSONB stores {"eval_example_id": ..., "eval_session_idx": ...}
so queries can filter to a specific example's sessions.

Embedding is computed in batch before insertion for efficiency.
"""
from __future__ import annotations

import asyncio
import math
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import psycopg

from .dataset import LongMemExample, parse_lme_date, session_text
from .db import get_dsn, session
from .embed import Embedder

# Brain type_id for Note
NOTE_TYPE_ID = 4
# Chunk size in characters (approximate)
CHUNK_SIZE = 800
CHUNK_OVERLAP = 100


@dataclass
class IngestedMemory:
    hyobject_id: str
    example_id: str
    session_idx: int
    text: str
    chunk_ids: list[str]
    session_id: str = ""
    is_evidence: bool = False


@dataclass
class _Rec:
    """Internal: one session staged for ingestion."""
    text: str
    example_id: str
    session_idx: int
    ts: datetime
    session_id: str
    is_evidence: bool


def _session_text(example: LongMemExample, session_idx: int) -> str:
    # Delegates to the shared formatter so role labels stay correct and
    # consistent between what we embed/store and what the reader sees.
    return session_text(example, session_idx)


def _chunk_text(text: str) -> list[str]:
    """Split text into overlapping character chunks."""
    if len(text) <= CHUNK_SIZE:
        return [text]
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        chunks.append(text[start:end])
        if end == len(text):
            break
        start += CHUNK_SIZE - CHUNK_OVERLAP
    return chunks


async def ingest_examples(
    examples: list[LongMemExample],
    workspace_id: str,
    embedder: Embedder,
    base_time: datetime | None = None,
    quiet: bool = False,
) -> list[IngestedMemory]:
    """
    Ingest all sessions from *examples* into the Brain workspace.

    Returns a list of IngestedMemory records (one per session).

    *base_time* is the timestamp assigned to the first session. Subsequent
    sessions are offset by 1 hour each so temporal sorting is meaningful.
    """
    if base_time is None:
        # Use a fixed reference time so runs are reproducible
        base_time = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

    # Build all records first so we can batch-embed. Each record carries the
    # real session timestamp (from the dataset's haystack_dates) so temporal
    # questions are answerable and the temporal strategy is meaningful; when a
    # date is missing we fall back to a synthetic, monotonically-increasing
    # timestamp so runs stay reproducible.
    records: list[_Rec] = []
    fallback_ts = base_time
    for ex in examples:
        for si in range(len(ex.sessions)):
            text = _session_text(ex, si)
            date_str = ex.session_dates[si] if si < len(ex.session_dates) else ""
            ts = parse_lme_date(date_str)
            if ts is None:
                ts = fallback_ts
                fallback_ts += timedelta(hours=1)
            sess_id = ex.session_ids[si] if si < len(ex.session_ids) else ""
            is_evidence = sess_id in ex.answer_session_ids if sess_id else False
            records.append(
                _Rec(text, ex.question_id, si, ts, sess_id, is_evidence)
            )

    if not records:
        return []

    texts = [r.text for r in records]
    if not quiet:
        print(f"[ingest] Embedding {len(texts)} sessions …")
    embeddings = embedder.embed(texts)

    if not quiet:
        print(
            f"[ingest] Writing {len(records)} hyobjects to "
            f"workspace {workspace_id} …"
        )
    ingested: list[IngestedMemory] = []

    # Write in batches of 50 to avoid huge transactions
    BATCH = 50
    for batch_start in range(0, len(records), BATCH):
        batch = records[batch_start : batch_start + BATCH]
        batch_embs = embeddings[batch_start : batch_start + BATCH]

        async with session(workspace_id) as conn:
            for rec, emb in zip(batch, batch_embs):
                text, ex_id, sess_idx, ts_ = (
                    rec.text, rec.example_id, rec.session_idx, rec.ts,
                )
                hyobj_id = str(uuid.uuid4())
                name = f"eval:{ex_id}:session:{sess_idx}"

                # Insert hyobject
                await conn.execute(
                    """
                    INSERT INTO hyobjects
                        (hyobject_id, workspace_id, type_id, subtype_id, name,
                         processing_state, created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, 'done', %s, %s)
                    """,
                    (
                        hyobj_id,
                        workspace_id,
                        NOTE_TYPE_ID,
                        1,
                        name,
                        ts_,
                        ts_,
                    ),
                )

                # Chunk + insert chunks with embeddings
                chunks = _chunk_text(text)
                chunk_ids: list[str] = []
                for ci, chunk_text in enumerate(chunks):
                    chunk_id = str(uuid.uuid4())
                    chunk_ids.append(chunk_id)
                    vec_str = f"[{','.join(str(x) for x in emb)}]"
                    await conn.execute(
                        """
                        INSERT INTO chunks
                            (chunk_id, hyobject_id, workspace_id, chunk_index, text,
                             embedding, created_at)
                        VALUES (%s, %s, %s, %s, %s, %s::vector, %s)
                        """,
                        (chunk_id, hyobj_id, workspace_id, ci, chunk_text, vec_str, ts_),
                    )

                    # Update hyobject full-text search vector
                    await conn.execute(
                        """
                        UPDATE hyobjects
                        SET content_tsv = to_tsvector('english', %s)
                        WHERE hyobject_id = %s
                        """,
                        (text[:10000], hyobj_id),
                    )

                ingested.append(
                    IngestedMemory(
                        hyobject_id=hyobj_id,
                        example_id=ex_id,
                        session_idx=sess_idx,
                        text=text,
                        chunk_ids=chunk_ids,
                        session_id=rec.session_id,
                        is_evidence=rec.is_evidence,
                    )
                )

    if not quiet:
        print(f"[ingest] Done — {len(ingested)} sessions ingested.")
    return ingested
