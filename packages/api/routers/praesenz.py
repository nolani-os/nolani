"""Presence: heartbeat, self-reported status, lookup.

Its own router (not under `/teams`) because presence does not belong to the
Teams app: every open ClaraOS surface reports it, and every app may display it.

Security: **who may see whose presence** — only people who share a team, the
same rule as for person profiles. Presence data reveals more than it seems:
anyone able to query it across all accounts can follow people's daily routines.
That is why the requested list is **filtered, not rejected** here — otherwise
the error message alone would reveal which accounts exist.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, Field

from auth import require_caller
from services import kontakte_abgleich as abgleich
from services import praesenz as svc

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/praesenz", tags=["praesenz"])


class HerzschlagBody(BaseModel):
    geraet: str | None = Field(None, max_length=60)


class ZustandBody(BaseModel):
    zustand: str | None = None          # None = back to automatic
    minuten: int | None = Field(None, ge=1, le=24 * 60)


@router.post("/herzschlag")
async def herzschlag(body: HerzschlagBody, request: Request) -> dict:
    """"I am here." Sent by every open surface, roughly once a minute."""
    caller = require_caller(request)
    await svc.herzschlag(caller, body.geraet)
    return {"ok": True}


@router.put("/zustand")
async def zustand(body: ZustandBody, request: Request) -> dict:
    """Set or clear the self-reported status."""
    caller = require_caller(request)
    try:
        await svc.zustand_setzen(caller, body.zustand, body.minuten)
    except ValueError as exc:
        return {"ok": False, "fehler": str(exc)}
    return {"ok": True}


@router.get("")
async def abfragen(
    request: Request,
    users: str = Query("", description="Kommaliste von Benutzernamen"),
) -> dict:
    """Status of the requested users, limited to people visible to the caller.

    Without `users`, the caller's own status is returned.
    """
    caller = require_caller(request)
    gefragt = [u.strip() for u in users.split(",") if u.strip()]
    if not gefragt:
        return await svc.fuer_nutzer([caller])

    sichtbar = set((await abgleich.sichtbare_nutzer(caller)).keys())
    sichtbar.add(caller)                       # you can always see yourself
    # Security: filter silently instead of rejecting — an error like "you may
    # not see this user" would confirm that the user exists.
    erlaubt = [u for u in gefragt if u in sichtbar]
    return await svc.fuer_nutzer(erlaubt)
