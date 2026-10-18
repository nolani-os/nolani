"""Agent keys — the user's own access keys for the MCP endpoint (Settings → Agents).

Only a person in the shell may list, create or revoke keys (`require_browser_user`):
a machine with the service token — the assistant included — must never be able to
mint itself an access key.
"""
from __future__ import annotations

import os
import uuid

import asyncpg
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import betriebsprofil
from auth import require_browser_user
from services import agent_keys

router = APIRouter(prefix="/api/claraos/agent-keys", tags=["agent-keys"])


class KeyIn(BaseModel):
    name: str = Field(default="Agent", max_length=agent_keys.NAME_MAX)
    can_write: bool = False


def _endpoint() -> str:
    base = os.environ.get("CLARAOS_PUBLIC_URL", "").rstrip("/")
    return f"{base}/mcp" if base else "/mcp"


@router.get("")
async def overview(request: Request) -> dict:
    """Whether the endpoint is on, its URL, the user's keys and their recent calls."""
    user = require_browser_user(request)
    try:
        keys = await agent_keys.list_keys(user)
        calls = await agent_keys.recent_calls(user)
    except asyncpg.UndefinedTableError:      # installation without migration 046
        keys, calls = [], []
    return {"enabled": betriebsprofil.MCP_ENABLED, "endpoint": _endpoint(),
            "keys": keys, "calls": calls, "max_keys": agent_keys.MAX_KEYS_PER_USER}


@router.post("")
async def create(body: KeyIn, request: Request) -> dict:
    """Create a key. The plain key is in this response only — it is not stored."""
    user = require_browser_user(request)
    if not betriebsprofil.MCP_ENABLED:
        raise HTTPException(409, "Der Agenten-Zugang ist in dieser Installation ausgeschaltet.")
    try:
        record, key = await agent_keys.create_key(user, body.name, body.can_write)
    except agent_keys.TooManyKeys:
        raise HTTPException(409, f"Höchstens {agent_keys.MAX_KEYS_PER_USER} Schlüssel — "
                                 "bitte zuerst einen alten widerrufen.")
    return {**record, "key": key, "endpoint": _endpoint()}


@router.delete("/{key_id}")
async def revoke(key_id: str, request: Request) -> dict:
    user = require_browser_user(request)
    try:
        uuid.UUID(key_id)
    except ValueError:
        raise HTTPException(400, "Ungültige Schlüssel-ID.")
    if not await agent_keys.revoke_key(user, key_id):
        raise HTTPException(404, "Schlüssel nicht gefunden.")
    return {"ok": True}
