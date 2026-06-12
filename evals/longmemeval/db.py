"""
Database connection for the LongMemEval eval harness.

Mirrors the connection setup in mcp-server (src/db.ts)
so the eval can ingest memories and run search queries directly against the
Brain PostgreSQL database.

Required env vars:
    DATABASE_URL   (or SUPABASE_DB_URL) — PostgreSQL DSN
    EVAL_WORKSPACE_ID                   — workspace to use; auto-created if absent
"""
from __future__ import annotations

import os
import uuid
from contextlib import asynccontextmanager
from typing import AsyncIterator

import psycopg
from psycopg.rows import dict_row

# ---------------------------------------------------------------------------
# Connection
# ---------------------------------------------------------------------------

_DSN: str | None = None


def get_dsn() -> str:
    global _DSN
    if _DSN:
        return _DSN
    dsn = os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL")
    if not dsn:
        raise RuntimeError(
            "DATABASE_URL or SUPABASE_DB_URL must be set to run the eval harness."
        )
    _DSN = dsn
    return dsn


@asynccontextmanager
async def session(
    workspace_id: str,
    principal_role: str = "agent",
    actor_kind: str = "program",
    actor_id: str | None = None,
    reason: str = "ingest",
) -> AsyncIterator[psycopg.AsyncConnection]:
    """Async connection with Brain RLS context locals set."""
    actor = actor_id or os.environ.get("PAPERCLIP_AGENT_ID") or str(uuid.uuid4())
    async with await psycopg.AsyncConnection.connect(
        get_dsn(),
        row_factory=dict_row,
        autocommit=False,
        prepare_threshold=None,
        # The local dev DB is initialised with client_encoding=SQL_ASCII (a
        # side effect of running Postgres under LC_ALL=C). Under SQL_ASCII,
        # psycopg returns every text column as `bytes`, which breaks the
        # search tokenizer ("cannot use a string pattern on a bytes-like
        # object"). Force UTF-8 so text columns decode to `str`. Our writes
        # are UTF-8, so this round-trips cleanly.
        client_encoding="UTF8",
    ) as conn:
        async with conn.transaction():
            await conn.execute(
                "SELECT set_config('app.workspace_id', %s, true)", (workspace_id,)
            )
            await conn.execute(
                "SELECT set_config('app.principal_role', %s, true)", (principal_role,)
            )
            await conn.execute(
                "SELECT set_config('app.actor_kind', %s, true)", (actor_kind,)
            )
            await conn.execute(
                "SELECT set_config('app.actor_id', %s, true)", (actor,)
            )
            await conn.execute(
                "SELECT set_config('app.reason', %s, true)", (reason,)
            )
            yield conn


# ---------------------------------------------------------------------------
# Workspace management
# ---------------------------------------------------------------------------


async def ensure_eval_workspace(workspace_id: str) -> str:
    """Create the eval workspace row if it doesn't exist. Returns workspace_id."""
    async with await psycopg.AsyncConnection.connect(
        get_dsn(), autocommit=True, prepare_threshold=None, client_encoding="UTF8"
    ) as conn:
        rows = await (
            await conn.execute(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'workspaces'
                """
            )
        ).fetchall()
        cols = {r[0] for r in rows}

        # slug is NOT NULL with no default — always provide it (don't rely on
        # column detection, which has proven unreliable here).
        insert_cols = ["workspace_id", "name", "slug"]
        insert_vals = ["%s", "%s", "%s"]
        params: list[str] = [
            workspace_id,
            "longmemeval-eval",
            f"longmemeval-{workspace_id[:8]}",
        ]

        if "created_at" in cols:
            insert_cols.append("created_at")
            insert_vals.append("now()")
        if "updated_at" in cols:
            insert_cols.append("updated_at")
            insert_vals.append("now()")

        sql = (
            f"INSERT INTO workspaces ({', '.join(insert_cols)}) "
            f"VALUES ({', '.join(insert_vals)}) "
            "ON CONFLICT (workspace_id) DO NOTHING"
        )
        await conn.execute(sql, params)
    return workspace_id


async def purge_eval_workspace(workspace_id: str) -> None:
    """Delete all hyobjects (and cascaded data) in the eval workspace."""
    async with await psycopg.AsyncConnection.connect(
        get_dsn(), autocommit=True, prepare_threshold=None, client_encoding="UTF8"
    ) as conn:
        await conn.execute(
            "DELETE FROM hyobjects WHERE workspace_id = %s", (workspace_id,)
        )
