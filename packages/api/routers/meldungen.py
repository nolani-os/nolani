"""Notifications for the shell's bell — for deployments without a push service.

Written by background work (routines, services/routinen.melden); the shell polls
`/api/claraos/meldungen`. Per user via row-level security (database.user_tx).
"""
from __future__ import annotations

from fastapi import APIRouter, Request

from auth import get_current_user
from database import user_tx

router = APIRouter(prefix="/api/claraos/meldungen", tags=["meldungen"])


@router.get("")
async def liste(request: Request, seit: int = 0) -> dict:
    """Newest notifications; `seit` = last id the client has seen (only newer ones)."""
    user = get_current_user(request)["username"]
    async with user_tx(user) as conn:
        rows = await conn.fetch(
            """SELECT id, erstellt, titel, text, app, gelesen FROM claraos_meldungen
               WHERE id > $1 ORDER BY id DESC LIMIT 50""", seit)
        ungelesen = await conn.fetchval("SELECT COUNT(*) FROM claraos_meldungen WHERE gelesen IS NULL")
    return {"ungelesen": ungelesen,
            "meldungen": [{**dict(r), "erstellt": r["erstellt"].isoformat(),
                           "gelesen": r["gelesen"].isoformat() if r["gelesen"] else None} for r in rows]}


@router.post("/gelesen")
async def alle_gelesen(request: Request) -> dict:
    user = get_current_user(request)["username"]
    async with user_tx(user) as conn:
        await conn.execute("UPDATE claraos_meldungen SET gelesen = NOW() WHERE gelesen IS NULL")
    return {"ok": True}
