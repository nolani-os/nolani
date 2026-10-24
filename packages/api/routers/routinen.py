"""Routines app — recurring tasks for Clara (services/routinen.py).

Every path is per user (row-level security via database.user_tx). Approving or
discarding a proposal is a human decision: only by button in the shell, never by a
tool or the brain (auth.require_browser_user).
"""
from __future__ import annotations

from betriebsprofil import ASSISTANT_NAME
import asyncio
import json
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth import require_browser_user, require_caller
from database import user_tx
from services import brain_turns, routinen

router = APIRouter(prefix="/api/claraos/routinen", tags=["routinen"])

Rhythmus = Literal["taeglich", "werktags", "woechentlich", "stuendlich"]


class RoutineIn(BaseModel):
    titel: str = Field(min_length=1, max_length=120)
    auftrag: str = Field(min_length=3, max_length=4000)
    rhythmus: Rhythmus = "taeglich"
    uhrzeit: str = Field(default="07:00", pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    wochentag: int | None = Field(default=None, ge=0, le=6)
    aktiv: bool = True


class Entscheidung(BaseModel):
    freigeben: bool


def _row(r) -> dict:
    d = dict(r)
    for k in ("id", "routine_id"):
        if k in d and d[k] is not None:
            d[k] = str(d[k])
    for k in ("erstellt", "letzter_lauf", "gestartet", "beendet"):
        if d.get(k) is not None:
            d[k] = d[k].isoformat()
    if isinstance(d.get("vorschlaege"), str):
        d["vorschlaege"] = json.loads(d["vorschlaege"])
    return d


@router.get("/status")
async def status(request: Request) -> dict:
    require_caller(request)
    return {"gehirn": brain_turns.enabled(), "lesend": {m: sorted(t) for m, t in routinen.LESEN.items()}}


@router.get("")
async def liste(request: Request) -> list[dict]:
    user = require_caller(request)
    async with user_tx(user) as conn:
        rows = await conn.fetch("SELECT * FROM claraos_routinen ORDER BY erstellt")
    return [_row(r) for r in rows]


@router.post("")
async def anlegen(body: RoutineIn, request: Request) -> dict:
    user = require_caller(request)
    async with user_tx(user) as conn:
        n = await conn.fetchval("SELECT COUNT(*) FROM claraos_routinen")
        if n >= 20:
            raise HTTPException(409, "Höchstens 20 Routinen je Nutzer.")
        r = await conn.fetchrow(
            """INSERT INTO claraos_routinen (username, titel, auftrag, rhythmus, uhrzeit, wochentag, aktiv)
               VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *""",
            user, body.titel, body.auftrag, body.rhythmus, body.uhrzeit,
            body.wochentag if body.rhythmus == "woechentlich" else None, body.aktiv)
    return _row(r)


@router.put("/{rid}")
async def aendern(rid: str, body: RoutineIn, request: Request) -> dict:
    user = require_caller(request)
    async with user_tx(user) as conn:
        r = await conn.fetchrow(
            """UPDATE claraos_routinen SET titel=$2, auftrag=$3, rhythmus=$4, uhrzeit=$5,
               wochentag=$6, aktiv=$7 WHERE id = $1::uuid RETURNING *""",
            rid, body.titel, body.auftrag, body.rhythmus, body.uhrzeit,
            body.wochentag if body.rhythmus == "woechentlich" else None, body.aktiv)
    if not r:
        raise HTTPException(404, "Routine nicht gefunden.")
    return _row(r)


class RoutineTeil(BaseModel):
    titel: str | None = Field(default=None, min_length=1, max_length=120)
    auftrag: str | None = Field(default=None, min_length=3, max_length=4000)
    rhythmus: Rhythmus | None = None
    uhrzeit: str | None = Field(default=None, pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    wochentag: int | None = Field(default=None, ge=0, le=6)
    aktiv: bool | None = None


@router.patch("/{rid}")
async def teilweise_aendern(rid: str, body: RoutineTeil, request: Request) -> dict:
    """Change only the fields sent (e.g. pause: {"aktiv": false}) — used by Clara."""
    user = require_caller(request)
    felder = body.model_dump(exclude_none=True)
    if not felder:
        raise HTTPException(400, "Nichts zu ändern.")
    async with user_tx(user) as conn:
        alt = await conn.fetchrow("SELECT * FROM claraos_routinen WHERE id = $1::uuid", rid)
        if not alt:
            raise HTTPException(404, "Routine nicht gefunden.")
        neu = {**dict(alt), **felder}
        r = await conn.fetchrow(
            """UPDATE claraos_routinen SET titel=$2, auftrag=$3, rhythmus=$4, uhrzeit=$5,
               wochentag=$6, aktiv=$7 WHERE id = $1::uuid RETURNING *""",
            rid, neu["titel"], neu["auftrag"], neu["rhythmus"], neu["uhrzeit"],
            neu["wochentag"] if neu["rhythmus"] == "woechentlich" else None, neu["aktiv"])
    return _row(r)


@router.delete("/{rid}")
async def loeschen(rid: str, request: Request) -> dict:
    user = require_caller(request)
    async with user_tx(user) as conn:
        n = await conn.execute("DELETE FROM claraos_routinen WHERE id = $1::uuid", rid)
    if n.endswith(" 0"):
        raise HTTPException(404, "Routine nicht gefunden.")
    return {"ok": True}


@router.post("/{rid}/jetzt")
async def jetzt(rid: str, request: Request) -> dict:
    """Run now (in the background) — the result arrives as a notification."""
    user = require_caller(request)
    if not brain_turns.enabled():
        raise HTTPException(424, f"{ASSISTANT_NAME}-Gehirn ist nicht angebunden — Routinen können nicht laufen.")
    async with user_tx(user) as conn:
        r = await conn.fetchrow("SELECT * FROM claraos_routinen WHERE id = $1::uuid", rid)
        laeuft = await conn.fetchval(
            # A run cut off by an API restart stays 'laeuft' forever — so only recent ones block.
            """SELECT COUNT(*) FROM claraos_routine_laeufe WHERE routine_id = $1::uuid
               AND status = 'laeuft' AND gestartet > NOW() - INTERVAL '15 minutes'""",
            rid)
    if not r:
        raise HTTPException(404, "Routine nicht gefunden.")
    if laeuft:
        raise HTTPException(409, "Diese Routine läuft gerade schon.")
    asyncio.get_event_loop().create_task(routinen.ausfuehren(dict(r)))
    return {"ok": True, "status": "gestartet"}


@router.get("/freigaben")
async def freigaben(request: Request) -> list[dict]:
    """Tool calls from the chat waiting for (or recently given) the user's decision."""
    user = require_caller(request)
    async with user_tx(user) as conn:
        rows = await conn.fetch(
            """SELECT * FROM claraos_routine_laeufe WHERE routine_id IS NULL
               AND (status = 'wartet' OR gestartet > NOW() - INTERVAL '2 days')
               ORDER BY gestartet DESC LIMIT 30""")
    return [_row(r) for r in rows]


@router.get("/{rid}/laeufe")
async def laeufe(rid: str, request: Request) -> list[dict]:
    user = require_caller(request)
    async with user_tx(user) as conn:
        rows = await conn.fetch(
            """SELECT * FROM claraos_routine_laeufe WHERE routine_id = $1::uuid
               ORDER BY gestartet DESC LIMIT 20""", rid)
    return [_row(r) for r in rows]


@router.post("/laeufe/{lauf_id}/vorschlaege/{index}")
async def entscheiden(lauf_id: str, index: int, body: Entscheidung, request: Request) -> dict:
    """Approve (execute as the owner) or discard one proposal — by button only."""
    user = require_browser_user(request)
    try:
        return await routinen.vorschlag_ausfuehren(user, lauf_id, index, body.freigeben)
    except LookupError as exc:
        raise HTTPException(404, str(exc))
