"""Invite table of the user administration (setup-wizard invites).

Shared by the user administration (create/list/revoke invites) and the public
onboarding endpoints of an installation that runs them.
"""
from __future__ import annotations

from database import get_pool

# ── Table (idempotent, also as migrations/010_onboarding_invites.sql) ─────

_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS claraos_invites (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash      TEXT NOT NULL UNIQUE,
    username        TEXT NOT NULL,
    display_name    TEXT NOT NULL DEFAULT '',
    created_by      TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    preauth_issues  INT NOT NULL DEFAULT 0,
    node_baseline   JSONB NOT NULL DEFAULT '[]',
    steps_completed JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_claraos_invites_username ON claraos_invites (username);
"""

_table_ready = False


async def ensure_invites_table() -> None:
    global _table_ready
    if _table_ready:
        return
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(_TABLE_SQL)
    _table_ready = True
