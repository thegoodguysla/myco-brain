"""
Embedding generation for the LongMemEval harness.

Tries providers in order:
  1. OpenAI text-embedding-3-small  (OPENAI_API_KEY)
  2. Local sentence-transformers all-MiniLM-L6-v2  (no key needed, dim=384)
     Note: local model outputs 384-dim vectors; Brain expects 1536 — padded
     with zeros so the eval still runs, but quality will be degraded.

Keep the interface synchronous for simplicity; the harness batches calls.
"""
from __future__ import annotations

import os
import time
from typing import Protocol

import numpy as np

BRAIN_EMBED_DIM = 1536


class Embedder(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]: ...
    @property
    def dim(self) -> int: ...


# ---------------------------------------------------------------------------
# OpenAI embedder
# ---------------------------------------------------------------------------


class OpenAIEmbedder:
    MODEL = "text-embedding-3-small"

    def __init__(self) -> None:
        import openai  # lazy import
        self._client = openai.OpenAI(api_key=os.environ["OPENAI_API_KEY"])
        self._warned_fallback = False

    @property
    def dim(self) -> int:
        return BRAIN_EMBED_DIM

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        # Sanitize: OpenAI returns a 400 (BadRequestError) if ANY input in the
        # batch is empty/whitespace or exceeds the 8192-token cap — which then
        # zero-vectors the whole batch and silently corrupts the run. Replace
        # empties with a single space and hard-truncate by chars (~4 chars/token,
        # so 28000 chars stays safely under the cap).
        texts = [((t if t and t.strip() else " ")[:28000]) for t in texts]
        # OpenAI batch limit is 2048 inputs
        results: list[list[float]] = []
        batch_size = 256
        for i in range(0, len(texts), batch_size):
            batch = texts[i : i + batch_size]
            for attempt in range(6):
                try:
                    resp = self._client.embeddings.create(
                        model=self.MODEL,
                        input=batch,
                        dimensions=BRAIN_EMBED_DIM,
                    )
                    results.extend([d.embedding for d in resp.data])
                    break
                except Exception as exc:
                    name = type(exc).__name__
                    transient = any(
                        s in name
                        for s in ("RateLimit", "Timeout", "APIConnection", "InternalServer")
                    )
                    if transient and attempt < 5:
                        time.sleep(2 ** attempt)  # 1,2,4,8,16s backoff
                        continue
                    # Last resort: a persistent failure. Zero-fill so the run
                    # continues, but warn loudly — these rows are NOT valid and
                    # invalidate the run's retrieval numbers.
                    if not self._warned_fallback:
                        print(
                            f"[embed] OpenAI embed FAILED after retries ({name}); "
                            "zero-vectoring this batch — results are NOT valid."
                        )
                        self._warned_fallback = True
                    results.extend([[0.0] * BRAIN_EMBED_DIM for _ in batch])
                    break
        return results


# ---------------------------------------------------------------------------
# Local sentence-transformers embedder (offline fallback)
# ---------------------------------------------------------------------------


class LocalEmbedder:
    MODEL = "sentence-transformers/all-MiniLM-L6-v2"

    def __init__(self) -> None:
        from sentence_transformers import SentenceTransformer  # type: ignore
        self._model = SentenceTransformer(self.MODEL)
        self._native_dim = self._model.get_sentence_embedding_dimension()

    @property
    def dim(self) -> int:
        return BRAIN_EMBED_DIM

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        vecs = self._model.encode(texts, normalize_embeddings=True)
        # Pad to 1536 so pgvector columns accept the vectors
        padded = np.zeros((len(vecs), BRAIN_EMBED_DIM), dtype=np.float32)
        padded[:, : self._native_dim] = vecs
        return padded.tolist()


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def get_embedder() -> Embedder:
    if os.environ.get("OPENAI_API_KEY"):
        try:
            emb = OpenAIEmbedder()
            print("[embed] Using OpenAI text-embedding-3-small")
            return emb
        except Exception as exc:
            print(f"[embed] OpenAI init failed ({exc}), falling back to local.")

    try:
        emb = LocalEmbedder()
        print(f"[embed] Using local {LocalEmbedder.MODEL} (padded to {BRAIN_EMBED_DIM}d)")
        return emb
    except ImportError:
        raise RuntimeError(
            "No embedding provider available. Install 'openai' (with OPENAI_API_KEY) "
            "or 'sentence-transformers' for local embeddings."
        )
