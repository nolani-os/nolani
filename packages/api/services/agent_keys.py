"""Agent keys: per-user bearer keys for the MCP endpoint (services/agent_mcp.py).

A key is `cak_` + 43 random URL-safe characters (256 bits). Only its SHA-256 hash is
stored (migrations/046_agent_keys.sql); the plain key exists once, in the response
that created it. A key names its owner and whether it may write — nothing the agent
sends can change either.

Checking a key looks it up by hash across all users through the plain pool (there is
no user yet at that point). Everything a user does with their own keys runs through
`database.user_tx`, i.e. under row-level security.
"""
from __future__ import annotations

import hashlib
import logging
import secrets
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from mcp.server.auth.provider import AccessToken

from database import get_pool, user_tx

logger = logging.getLogger(__name__)

PREFIX = "cak_"
MAX_KEYS_PER_USER = 10
NAME_MAX = 60
CALLS_KEEP_DAYS = 90
_LAST_USED_EVERY_S = 60     # write `last_used` at most once a minute per key

_last_used_written: dict[str, float] = {}


def new_key() -> str:
    return PREFIX + secrets.token_urlsafe(32)


def key_hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


@asynccontextmanager
async def _user_conn(username: str) -> AsyncIterator[Any]:
    """Connection under row-level security for `username` (tests replace this)."""
    async with user_tx(username) as conn:
        yield conn


@asynccontextmanager
async def _lookup_conn() -> AsyncIterator[Any]:
    """Plain-pool connection for the cross-user lookup by hash (tests replace this)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        yield conn


def _public(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "prefix": row["key_prefix"],
        "can_write": row["can_write"],
        "created": row["created"].isoformat() if row["created"] else None,
        "last_used": row["last_used"].isoformat() if row["last_used"] else None,
    }


async def list_keys(username: str) -> list[dict[str, Any]]:
    """The user's active keys, newest first (never the hash)."""
    async with _user_conn(username) as conn:
        rows = await conn.fetch(
            "SELECT id, name, key_prefix, can_write, created, last_used FROM claraos_agent_keys "
            "WHERE username = $1 AND revoked IS NULL ORDER BY created DESC", username)
    return [_public(r) for r in rows]


class TooManyKeys(Exception):
    pass


async def create_key(username: str, name: str, can_write: bool) -> tuple[dict[str, Any], str]:
    """Create a key; returns (public record, plain key). The plain key is not stored."""
    name = " ".join((name or "").split())[:NAME_MAX] or "Agent"
    key = new_key()
    async with _user_conn(username) as conn:
        active = await conn.fetchval(
            "SELECT count(*) FROM claraos_agent_keys WHERE username = $1 AND revoked IS NULL", username)
        if active >= MAX_KEYS_PER_USER:
            raise TooManyKeys
        row = await conn.fetchrow(
            "INSERT INTO claraos_agent_keys (username, name, key_hash, key_prefix, can_write) "
            "VALUES ($1, $2, $3, $4, $5) "
            "RETURNING id, name, key_prefix, can_write, created, last_used",
            username, name, key_hash(key), key[: len(PREFIX) + 4], bool(can_write))
    logger.info("[agent-keys] %s created key %s (%s, write=%s)", username, row["id"], name, can_write)
    return _public(row), key


async def revoke_key(username: str, key_id: str) -> bool:
    async with _user_conn(username) as conn:
        result = await conn.execute(
            "UPDATE claraos_agent_keys SET revoked = NOW() "
            "WHERE id = $1::uuid AND username = $2 AND revoked IS NULL", key_id, username)
    done = result.endswith(" 1")
    if done:
        logger.info("[agent-keys] %s revoked key %s", username, key_id)
    return done


async def revoke_all(username: str) -> int:
    """Revoke every key of a user (account deactivated). Admin path: plain pool."""
    async with _lookup_conn() as conn:
        result = await conn.execute(
            "UPDATE claraos_agent_keys SET revoked = NOW() WHERE username = $1 AND revoked IS NULL",
            username)
    return int(result.split()[-1]) if result else 0


async def recent_calls(username: str, limit: int = 30) -> list[dict[str, Any]]:
    async with _user_conn(username) as conn:
        rows = await conn.fetch(
            "SELECT c.tool, c.ok, c.at, k.name AS key_name FROM claraos_agent_calls c "
            "LEFT JOIN claraos_agent_keys k ON k.id = c.key_id "
            "WHERE c.username = $1 ORDER BY c.at DESC LIMIT $2", username, limit)
    return [{"tool": r["tool"], "ok": r["ok"], "at": r["at"].isoformat(), "key": r["key_name"]}
            for r in rows]


async def record_call(username: str, key_id: str | None, tool: str, ok: bool) -> None:
    """Log one tool call (no arguments). Never raises — logging must not break a call."""
    try:
        async with _user_conn(username) as conn:
            await conn.execute(
                "INSERT INTO claraos_agent_calls (key_id, username, tool, ok) VALUES ($1::uuid, $2, $3, $4)",
                key_id, username, tool, ok)
            await conn.execute(
                "DELETE FROM claraos_agent_calls WHERE username = $1 "
                f"AND at < NOW() - INTERVAL '{CALLS_KEEP_DAYS} days'", username)
    except Exception as e:  # noqa: BLE001
        logger.warning("[agent-keys] call log failed for %s: %s", username, e)


async def verify(key: str) -> AccessToken | None:
    """The access a presented key grants, or None (unknown, revoked, malformed)."""
    if not key or not key.startswith(PREFIX) or len(key) > 100:
        return None
    try:
        async with _lookup_conn() as conn:
            row = await conn.fetchrow(
                "SELECT id, username, can_write FROM claraos_agent_keys "
                "WHERE key_hash = $1 AND revoked IS NULL", key_hash(key))
            if row is None:
                return None
            key_id = str(row["id"])
            now = time.monotonic()
            if now - _last_used_written.get(key_id, 0.0) > _LAST_USED_EVERY_S:
                _last_used_written[key_id] = now
                await conn.execute("UPDATE claraos_agent_keys SET last_used = NOW() WHERE id = $1", row["id"])
    except Exception as e:  # noqa: BLE001 — a DB hiccup refuses the key, never admits it
        logger.warning("[agent-keys] verify failed: %s", e)
        return None
    scopes = ["read", "write"] if row["can_write"] else ["read"]
    return AccessToken(token=key, client_id=row["username"], scopes=scopes, claims={"key_id": key_id})


class KeyVerifier:
    """TokenVerifier for the MCP endpoint, backed by the agent keys table."""

    async def verify_token(self, token: str) -> AccessToken | None:
        return await verify(token)
