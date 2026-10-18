"""People endpoints of the Teams app — search and profile.

Two rules, same as in the contacts router:

  1. **Identity only via `auth.require_caller`** — never read an identity
     header raw (that would let a client spoof its identity).
  2. **No SQL here.** The logic lives in `services/teams_personen.py`, the
     visibility rule in `services/kontakte_abgleich.sichtbare_nutzer`.

Security: **only people who share a team with the caller are visible.** The
profile of an invisible user therefore returns **404** — the same code as a
non-existent one. A 403 would reveal that the account exists and make the
user directory enumerable row by row.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query, Request

from auth import require_caller
from services import teams_personen as personen_svc

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/teams/personen", tags=["teams-personen"])

# Separate router: conversations are not a sub-resource of a person. Mounted
# under /personen/{username}/…, FastAPI would read "gespraeche" as a username —
# the same trap as a static route declared after a `/{id}` route, which then
# is never reached.
gespraeche_router = APIRouter(prefix="/api/claraos/teams/gespraeche", tags=["teams-gespraeche"])


@gespraeche_router.get("")
async def gespraeche(request: Request) -> list[dict]:
    """The caller's conversations outside Matrix (currently: Nextcloud Talk).

    Matrix rooms are NOT included: the browser already knows them fully through
    its own session, including unread counters and live updates. Mirroring them
    here would mean keeping two sources of truth for the same room.
    """
    caller = require_caller(request)
    return await personen_svc.talk_gespraeche(caller)


@router.get("")
async def liste(
    request: Request,
    q: str | None = Query(None, description="Filter auf Name, Benutzername oder Mail"),
) -> list[dict]:
    """People the caller may see — optionally filtered."""
    caller = require_caller(request)          # -> username (str)
    return await personen_svc.personen(caller, q)


@router.get("/{username}")
async def einzelnes_profil(username: str, request: Request) -> dict:
    """Profile of a person, including the channels through which they can be reached."""
    caller = require_caller(request)
    p = await personen_svc.profil(caller, username)
    if not p:
        # Deliberately 404 instead of 403 — see module docstring.
        raise HTTPException(404, "Person nicht gefunden")
    return p


@router.post("/{username}/talk")
async def talk_starten(username: str, request: Request) -> dict:
    """Open a Nextcloud Talk conversation with this person.

    Matrix is deliberately NOT started here: the browser already has a session
    for that (`startDM` in matrixClient), and a server-side detour would need a
    second token for the same person. Talk, on the other hand, is unknown to
    the browser — its credentials exist only here.
    """
    caller = require_caller(request)
    # Security: first check that the person is visible at all. Without this,
    # anyone could force a conversation with an arbitrary account and thereby
    # learn that it exists.
    if not await personen_svc.profil(caller, username):
        raise HTTPException(404, "Person nicht gefunden")
    try:
        return await personen_svc.talk_gespraech(caller, username)
    except RuntimeError as exc:
        # Surface the reason in the UI: "doesn't work" without a why just makes
        # people press the same button five more times.
        raise HTTPException(502, str(exc)) from exc
