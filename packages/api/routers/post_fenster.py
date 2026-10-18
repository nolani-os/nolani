"""Mail app — "one window".

Two things that make an Outlook-style client one window instead of four:

1. **Cross-app search** — one field searches mail, contacts, tasks and events.
   Not as a new index but as a **fan-out**: each app is asked about its own
   data, and the answers come back grouped.
   Important: a separate index would be a second source of truth — and it would
   be stale the moment someone moves a mail.

2. **Profile card** — who is the sender, and what did we last have to do with
   them? Also a fan-out: contact from the contacts app, recent mails from the
   mailbox, shared events from the calendar.

Both routes are **fault tolerant**: if one source fails, its section is
missing — the rest still comes back. A search that fails entirely because of
one broken source is worse than one that says what it could not reach.
Same lesson as with the directory: *"empty" is a different statement than
"incomplete".*
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query, Request

from auth import require_caller
from routers.post import _internal, _jmap, _jmap_session, _by_tag, _email_row, LIST_PROPS

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/post", tags=["post"])

LOCAL_TZ = ZoneInfo("Europe/Berlin")


async def _mail_treffer(user: str, q: str, limit: int) -> list[dict[str, Any]]:
    """Full-text search in the mailbox — the same JMAP query as the list, just shorter."""
    s = await _jmap_session(user)
    resp = await _jmap(user, [
        ["Email/query", {"accountId": s["account"], "filter": {"text": q},
                         "sort": [{"property": "receivedAt", "isAscending": False}],
                         "collapseThreads": True, "limit": limit}, "q"],
        ["Email/get", {"accountId": s["account"],
                       "#ids": {"resultOf": "q", "name": "Email/query", "path": "/ids"},
                       "properties": LIST_PROPS}, "g"],
    ])
    reihenfolge = {i: n for n, i in enumerate(_by_tag(resp, "q").get("ids") or [])}
    zeilen = sorted((_email_row(e) for e in _by_tag(resp, "g").get("list") or []),
                    key=lambda r: reihenfolge.get(r["id"], 1e9))
    return [{"id": z["id"], "titel": z.get("subject") or "(ohne Betreff)",
             "zeile": ", ".join(a.get("name") or a.get("email", "") for a in (z.get("from") or [])),
             "datum": z.get("received_at"), "ungelesen": z.get("unread")} for z in zeilen]


async def _kontakt_treffer(user: str, q: str, limit: int) -> list[dict[str, Any]]:
    async with _internal(user) as cl:
        r = await cl.get("/api/claraos/contacts", params={"q": q, "limit": limit})
    if r.status_code != 200:
        raise RuntimeError(f"Kontakte {r.status_code}")
    out = []
    for k in (r.json().get("contacts") or [])[:limit]:
        namen = k.get("namen") or {}
        name = (namen.get("anzeige") or " ".join(
            x for x in [namen.get("vorname"), namen.get("nachname")] if x) or "").strip()
        mails = [m.get("wert") for m in (k.get("mails") or []) if m.get("wert")]
        out.append({"id": k.get("id"), "titel": name or (mails[0] if mails else "(ohne Namen)"),
                    "zeile": ", ".join(mails[:2]), "datum": None})
    return out


async def _planner_treffer(user: str, q: str, limit: int) -> tuple[list[dict], list[dict]]:
    """Tasks and events of the surrounding weeks, filtered by text.

    The planner has no full-text search over events — so a time window is
    fetched and filtered here. This is honestly limited (±60 days) and the
    response says so, instead of claiming "nothing found".
    """
    jetzt = datetime.now(LOCAL_TZ)
    von, bis = jetzt - timedelta(days=60), jetzt + timedelta(days=60)
    async with _internal(user) as cl:
        r = await cl.get("/api/claraos/planner/events",
                         params={"start": von.isoformat(), "end": bis.isoformat()})
    if r.status_code != 200:
        raise RuntimeError(f"Planner {r.status_code}")
    d = r.json()
    nadel = q.lower()
    termine = [{"id": e.get("uid"), "titel": e.get("summary") or "(ohne Titel)",
                "zeile": e.get("location") or e.get("calendar") or "", "datum": e.get("start")}
               for e in (d.get("events") or [])
               if nadel in (e.get("summary") or "").lower()
               or nadel in (e.get("location") or "").lower()][:limit]
    aufgaben = [{"id": t.get("id"), "titel": t.get("title") or "(ohne Titel)",
                 "zeile": "erledigt" if t.get("done") else "offen", "datum": t.get("due_date")}
                for t in (d.get("tasks") or [])
                if nadel in (t.get("title") or "").lower()][:limit]
    return aufgaben, termine


@router.get("/suche")
async def post_suche(request: Request, q: str = Query(..., min_length=2, max_length=120),
                     limit: int = Query(8, ge=1, le=25)):
    """One field, four sources. Each source may fail on its own."""
    user = require_caller(request)
    nadel = q.strip()
    if not nadel:
        raise HTTPException(status_code=400, detail="Suchbegriff fehlt")

    ergebnis: dict[str, Any] = {"mails": [], "kontakte": [], "aufgaben": [], "termine": []}
    nicht_erreicht: list[str] = []

    mails, kontakte, planner = await asyncio.gather(
        _mail_treffer(user, nadel, limit),
        _kontakt_treffer(user, nadel, limit),
        _planner_treffer(user, nadel, limit),
        return_exceptions=True,
    )

    for name, wert in (("Postfach", mails), ("Kontakte", kontakte), ("Planner", planner)):
        if isinstance(wert, Exception):
            nicht_erreicht.append(name)
            logger.info("Suche: %s nicht erreicht (%s)", name, wert)

    if not isinstance(mails, Exception):
        ergebnis["mails"] = mails
    if not isinstance(kontakte, Exception):
        ergebnis["kontakte"] = kontakte
    if not isinstance(planner, Exception):
        ergebnis["aufgaben"], ergebnis["termine"] = planner

    return {**ergebnis, "suchbegriff": nadel,
            "gesamt": sum(len(v) for v in ergebnis.values() if isinstance(v, list)),
            "nicht_erreicht": nicht_erreicht,
            "hinweis": ("Termine und Aufgaben werden im Fenster ±60 Tage durchsucht."
                        if not nicht_erreicht else
                        "Nicht erreicht: " + ", ".join(nicht_erreicht))}


@router.get("/profil")
async def post_profil(request: Request, email: str = Query(..., min_length=3, max_length=200)):
    """Who is this — and what did we last have to do with each other?

    Shows: the contact (if any), recent mails in both directions and shared
    events. Deliberately without "files": the files app has no link to people,
    so a match there would be a guess.
    """
    user = require_caller(request)
    adresse = email.strip().lower()

    async def kontakt() -> dict[str, Any] | None:
        async with _internal(user) as cl:
            r = await cl.get("/api/claraos/contacts", params={"q": adresse, "limit": 5})
        if r.status_code != 200:
            raise RuntimeError(f"Kontakte {r.status_code}")
        for k in r.json().get("contacts") or []:
            for m in k.get("mails") or []:
                if (m.get("wert") or "").lower() == adresse:
                    namen = k.get("namen") or {}
                    return {"id": k.get("id"),
                            "name": (namen.get("anzeige") or " ".join(
                                x for x in [namen.get("vorname"), namen.get("nachname")] if x)).strip(),
                            "telefone": [t.get("wert") for t in (k.get("telefone") or [])][:3],
                            "firma": (k.get("organisation") or {}).get("firma") if isinstance(
                                k.get("organisation"), dict) else None}
        return None

    async def mails() -> list[dict[str, Any]]:
        return await _mail_treffer(user, adresse, 6)

    async def termine() -> list[dict[str, Any]]:
        jetzt = datetime.now(LOCAL_TZ)
        async with _internal(user) as cl:
            r = await cl.get("/api/claraos/planner/events",
                             params={"start": (jetzt - timedelta(days=30)).isoformat(),
                                     "end": (jetzt + timedelta(days=60)).isoformat()})
        if r.status_code != 200:
            raise RuntimeError(f"Planner {r.status_code}")
        treffer = []
        for e in r.json().get("events") or []:
            wer = [(a.get("email") or "").lower() for a in (e.get("attendees") or [])]
            if adresse in wer or adresse == (e.get("organizer") or "").lower().replace("mailto:", ""):
                treffer.append({"id": e.get("uid"), "titel": e.get("summary") or "(ohne Titel)",
                                "datum": e.get("start")})
        return treffer[:5]

    k, m, t = await asyncio.gather(kontakt(), mails(), termine(), return_exceptions=True)
    fehlend = [n for n, v in (("Kontakte", k), ("Postfach", m), ("Kalender", t)) if isinstance(v, Exception)]
    return {"email": adresse,
            "kontakt": None if isinstance(k, Exception) else k,
            "mails": [] if isinstance(m, Exception) else m,
            "termine": [] if isinstance(t, Exception) else t,
            "nicht_erreicht": fehlend}
