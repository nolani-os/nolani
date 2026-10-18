"""Rendezvous for user answers to the clara-agent.

Replaces a Redis rendezvous for the chat back channels (ask_user_question +
plan approval) that did not work when claraos-api and clara-agent run on
different hosts without a shared Redis — the frontend wrote into the void (or got a 500
because the redis package is missing from the api image), and the agent polled
a key nobody ever set.

New approach, following the proven confirm pattern, just without the
ntfy/public path:

  1. The frontend answers a card -> POST /chat/v2/question-response or
     /plan-response -> save_response() stores the answer in Postgres.
  2. clara-agent polls GET /chat/v2/agent-response/{request_id}
     (cluster-internal, gated by _trusted_caller) -> consume_response() returns
     the value exactly once (single-use) and only within the TTL.

The agent generates the request_id (uuid4().hex, 128 bit) and it reaches the
frontend only via the authenticated SSE stream — together with TTL and
single-use semantics this replaces a separate token.
"""
from __future__ import annotations

import logging

from database import get_pool

logger = logging.getLogger(__name__)

VALID_KINDS = ("question", "plan")

_tables_ensured = False


async def _ensure_tables() -> None:
    global _tables_ensured
    if _tables_ensured:
        return
    pool = await get_pool()
    async with pool.acquire() as conn:
        try:
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS claraos_agent_responses (
                    request_id  TEXT PRIMARY KEY,
                    kind        TEXT NOT NULL,
                    value       TEXT NOT NULL,
                    username    TEXT NOT NULL,
                    created_at  TIMESTAMPTZ DEFAULT NOW(),
                    consumed_at TIMESTAMPTZ,
                    expires_at  TIMESTAMPTZ NOT NULL
                )
            """)
        except Exception:
            # CREATE IF NOT EXISTS can collide in the pg_type catalog on
            # concurrent first access — the table exists in that case.
            logger.debug("agent_responses: CREATE race ignoriert", exc_info=True)
    _tables_ensured = True


async def save_response(
    request_id: str, kind: str, value: str, username: str, ttl_s: float
) -> str:
    """Store an answer. Returns 'stored' | 'already_consumed'.

    Before consumption the latest answer from the same user wins (double
    click, second device); an answer that has been consumed is immutable.
    """
    await _ensure_tables()
    pool = await get_pool()
    async with pool.acquire() as conn:
        # Opportunistic cleanup — keeps the table small, no cron needed.
        await conn.execute(
            "DELETE FROM claraos_agent_responses"
            " WHERE expires_at < NOW() - interval '1 hour'"
        )
        row = await conn.fetchrow(
            """
            INSERT INTO claraos_agent_responses
                (request_id, kind, value, username, expires_at)
            VALUES ($1, $2, $3, $4, NOW() + make_interval(secs => $5))
            ON CONFLICT (request_id) DO UPDATE
                SET value = EXCLUDED.value,
                    username = EXCLUDED.username,
                    expires_at = EXCLUDED.expires_at
                WHERE claraos_agent_responses.consumed_at IS NULL
            RETURNING request_id
            """,
            request_id, kind, value, username, float(ttl_s),
        )
    return "stored" if row else "already_consumed"


async def consume_response(request_id: str) -> str | None:
    """Fetch an answer exactly once; None = nothing there (yet) or expired."""
    await _ensure_tables()
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE claraos_agent_responses
               SET consumed_at = NOW()
             WHERE request_id = $1
               AND consumed_at IS NULL
               AND expires_at > NOW()
            RETURNING value
            """,
            request_id,
        )
    return row["value"] if row else None
