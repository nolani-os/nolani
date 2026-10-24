"""Planner calendar extras: resources, meeting polls, meeting rooms.

Three things Outlook calls "business" features that still make sense in a
household:

* **Resources** (car, guest room, workshop): a dedicated Nextcloud calendar per
  item, owned by clara.bot and shared with the household. Booking means an
  event in that calendar, with a conflict check, because that is the whole
  point. A car booked twice is the only failure that matters here.

* **Meeting poll** ("when does it suit everyone?"): several time proposals,
  each person votes, and one proposal finally becomes an event. Deliberately
  stored in ClaraOS rather than Nextcloud Polls: the poll must know the
  participants and the time proposals in order to create an event from them.

* **Meeting room**: Important: a bare Element Call URL is NOT a meeting link,
  just Element's login screen. A call lives in a Matrix room, so the link must
  point into the Teams app at exactly that room. There is no link for people
  without an account; that limitation is stated here rather than hidden.

Kept in its own module, separate from `planner_kalender.py`.
"""
from __future__ import annotations

from betriebsprofil import PRODUCT_NAME
import os
from domains_generated import BASE_DOMAIN  # per deployment: CLARAOS_BASE_DOMAIN
import json
import logging
import re
import uuid
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from auth import get_current_user, require_caller
from database import get_pool

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/planner", tags=["planner"])

LOCAL_TZ = ZoneInfo("Europe/Berlin")
RESSOURCE_ARTEN = {"raum": "Raum", "fahrzeug": "Fahrzeug", "geraet": "Gerät", "sonstiges": "Sonstiges"}
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")

_tables_ensured = False


async def _ensure_tables() -> None:
    global _tables_ensured
    if _tables_ensured:
        return
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_ressourcen (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL,
                art           TEXT NOT NULL DEFAULT 'sonstiges',
                beschreibung  TEXT NOT NULL DEFAULT '',
                kalender_uri  TEXT NOT NULL,
                aktiv         BOOLEAN NOT NULL DEFAULT TRUE,
                angelegt_von  TEXT NOT NULL,
                angelegt_am   TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_terminumfrage (
                id           TEXT PRIMARY KEY,
                ersteller    TEXT NOT NULL,
                titel        TEXT NOT NULL,
                ort          TEXT NOT NULL DEFAULT '',
                dauer_min    INTEGER NOT NULL DEFAULT 60,
                optionen     JSONB NOT NULL DEFAULT '[]'::jsonb,
                teilnehmer   JSONB NOT NULL DEFAULT '[]'::jsonb,
                status       TEXT NOT NULL DEFAULT 'offen',
                gewaehlt     INTEGER,
                erstellt_am  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_buchungsseite (
                username   TEXT PRIMARY KEY,
                aktiv      BOOLEAN NOT NULL DEFAULT FALSE,
                dauer_min  INTEGER NOT NULL DEFAULT 30,
                von_uhr    INTEGER NOT NULL DEFAULT 9,
                bis_uhr    INTEGER NOT NULL DEFAULT 18,
                werktags   BOOLEAN NOT NULL DEFAULT TRUE,
                titel      TEXT NOT NULL DEFAULT 'Termin',
                hinweis    TEXT NOT NULL DEFAULT ''
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_terminumfrage_stimme (
                umfrage_id  TEXT NOT NULL,
                person      TEXT NOT NULL,
                option_idx  INTEGER NOT NULL,
                antwort     TEXT NOT NULL,
                gesetzt_am  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (umfrage_id, person, option_idx)
            )
        """)
    _tables_ensured = True


def _admin_pflicht(request: Request) -> None:
    if (get_current_user(request) or {}).get("role") != "admin":
        raise HTTPException(status_code=403, detail="Nur Administratoren dürfen das")


# ── Resources ───────────────────────────────────────────────────────────────

class RessourceIn(BaseModel):
    id: str                       # slug, e.g. "auto" or "gaestezimmer"
    name: str                     # display name, e.g. "Family car"
    art: str = "sonstiges"
    beschreibung: str = ""
    gruppe: str = ""              # Nextcloud group that should see the calendar


@router.get("/ressourcen")
async def ressourcen(request: Request):
    require_caller(request)
    await _ensure_tables()
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT id, name, art, beschreibung, kalender_uri, aktiv "
                                "FROM claraos_ressourcen WHERE aktiv ORDER BY art, name")
    return {"ressourcen": [dict(r) for r in rows],
            "arten": [{"id": k, "name": v} for k, v in RESSOURCE_ARTEN.items()]}


@router.post("/ressourcen")
async def ressource_anlegen(body: RessourceIn, request: Request):
    """Create a bookable resource, including its calendar.

    The calendar is owned by clara.bot (as with the team calendars), so it does
    not disappear when a household member loses their account.
    """
    require_caller(request)
    _admin_pflicht(request)
    await _ensure_tables()
    if not SLUG_RE.fullmatch(body.id):
        raise HTTPException(status_code=400, detail="Kennung: klein, ohne Leerzeichen, z. B. „gaestezimmer“")
    if body.art not in RESSOURCE_ARTEN:
        raise HTTPException(status_code=400, detail=f"Unbekannte Art {body.art!r}")

    from routers.teams_admin import nc_calendar_create, nc_calendar_share_group
    cal_id = f"ressource-{body.id}"
    uri = await nc_calendar_create(cal_id, body.name)
    if not uri:
        # Already existing is not an error; then we use the existing one.
        uri = f"/remote.php/dav/calendars/clara.bot/{cal_id}/"
        logger.info("Ressourcen-Kalender %s existierte bereits", cal_id)
    if body.gruppe:
        await nc_calendar_share_group(uri, body.gruppe, body.name)

    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            INSERT INTO claraos_ressourcen (id, name, art, beschreibung, kalender_uri, angelegt_von)
            VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, art = EXCLUDED.art,
                                           beschreibung = EXCLUDED.beschreibung, aktiv = TRUE
        """, body.id, body.name, body.art, body.beschreibung, uri, require_caller(request))
    return {"ok": True, "id": body.id, "kalender_uri": uri}


async def _ressource(rid: str) -> dict[str, Any]:
    await _ensure_tables()
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM claraos_ressourcen WHERE id = $1 AND aktiv", rid)
    if not row:
        raise HTTPException(status_code=404, detail=f"Ressource {rid!r} gibt es nicht")
    return dict(row)


def _ical_stamp(dt: datetime) -> str:
    return dt.astimezone(ZoneInfo("UTC")).strftime("%Y%m%dT%H%M%SZ")


def _parse_iso(iso: str, feld: str) -> datetime:
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"{feld}: {iso!r} ist keine Zeitangabe") from e
    return d if d.tzinfo else d.replace(tzinfo=LOCAL_TZ)


async def _belegung(uri: str, von: datetime, bis: datetime) -> list[dict[str, Any]]:
    """Events of the resource in the given range, via CalDAV time-range.

    A REPORT returns the raw iCal texts; we only read start, end, title and UID.
    Everything else (recurrence, exceptions) is handled by the main planner
    calendar code; in practice a resource is booked individually, not as a
    series.
    """
    from routers.teams_admin import NEXTCLOUD_URL, _nc_admin_auth
    auth = await _nc_admin_auth()
    xml = f'''<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">
    <C:time-range start="{_ical_stamp(von)}" end="{_ical_stamp(bis)}"/>
  </C:comp-filter></C:comp-filter></C:filter>
</C:calendar-query>'''
    async with httpx.AsyncClient(verify=False, timeout=20) as c:
        r = await c.request("REPORT", NEXTCLOUD_URL + uri, auth=auth,
                            headers={"Depth": "1", "Content-Type": "application/xml; charset=utf-8"},
                            content=xml)
    if r.status_code not in (207, 200):
        raise HTTPException(status_code=502, detail=f"Kalender antwortet {r.status_code}")

    out: list[dict[str, Any]] = []
    for block in re.findall(r"BEGIN:VEVENT(.*?)END:VEVENT", r.text, re.S):
        text = block.replace("&#13;", "").replace("\r\n ", "").replace("\n ", "")

        def feld(name: str) -> str:
            m = re.search(rf"^{name}[^:\r\n]*:(.*)$", text, re.M)
            return (m.group(1).strip() if m else "")
        anfang, ende = feld("DTSTART"), feld("DTEND")
        if not anfang:
            continue
        out.append({"uid": feld("UID"), "titel": feld("SUMMARY") or "(ohne Titel)",
                    "von": _ical_lesen(anfang), "bis": _ical_lesen(ende) if ende else None,
                    "wer": feld("ORGANIZER").replace("mailto:", "")})
    out.sort(key=lambda x: x["von"] or "")
    return out


def _ical_lesen(wert: str) -> str:
    """`20260914T090000Z` or `20260914T090000` -> ISO time with zone."""
    w = wert.strip()
    try:
        if w.endswith("Z"):
            d = datetime.strptime(w, "%Y%m%dT%H%M%SZ").replace(tzinfo=ZoneInfo("UTC"))
        elif "T" in w:
            d = datetime.strptime(w[:15], "%Y%m%dT%H%M%S").replace(tzinfo=LOCAL_TZ)
        else:
            d = datetime.strptime(w[:8], "%Y%m%d").replace(tzinfo=LOCAL_TZ)
    except ValueError:
        return w
    return d.astimezone(LOCAL_TZ).isoformat()


@router.get("/ressourcen/{rid}/belegung")
async def ressource_belegung(rid: str, request: Request,
                             von: str = Query(...), bis: str = Query(...)):
    require_caller(request)
    res = await _ressource(rid)
    return {"ressource": {"id": res["id"], "name": res["name"]},
            "belegung": await _belegung(res["kalender_uri"], _parse_iso(von, "von"), _parse_iso(bis, "bis"))}


class BuchungIn(BaseModel):
    von: str
    bis: str
    titel: str
    notiz: str = ""


@router.post("/ressourcen/{rid}/buchung")
async def ressource_buchen(rid: str, body: BuchungIn, request: Request):
    """Book the resource, or report who already has it.

    Important: the conflict check is the purpose of this function, not an
    extra. Between checking and writing there is a moment in which someone else
    could book. So after writing we **read again**: if another booking now
    exists in the same range, we withdraw ours and report the conflict instead
    of double-booking the car.
    """
    user = require_caller(request)
    res = await _ressource(rid)
    von, bis = _parse_iso(body.von, "von"), _parse_iso(body.bis, "bis")
    if bis <= von:
        raise HTTPException(status_code=400, detail="Ende liegt vor dem Anfang")

    vorher = await _belegung(res["kalender_uri"], von, bis)
    if vorher:
        raise HTTPException(status_code=409, detail={
            "meldung": f"{res['name']} ist in dieser Zeit schon vergeben",
            "konflikte": vorher})

    from routers.teams_admin import NEXTCLOUD_URL, _nc_admin_auth
    uid = f"ressource-{rid}-{uuid.uuid4().hex[:12]}"
    ical = "\r\n".join([
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ClaraOS//Ressourcen//DE",
        "BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{_ical_stamp(datetime.now(LOCAL_TZ))}",
        f"DTSTART:{_ical_stamp(von)}", f"DTEND:{_ical_stamp(bis)}",
        f"SUMMARY:{_esc(body.titel)}",
        f"DESCRIPTION:{_esc(body.notiz)}" if body.notiz else "DESCRIPTION:",
        f"ORGANIZER;CN={_esc(user)}:mailto:{user}@{os.environ.get('STALWART_MAIL_DOMAIN', BASE_DOMAIN)}",
        "END:VEVENT", "END:VCALENDAR", ""])
    auth = await _nc_admin_auth()
    url = f"{NEXTCLOUD_URL}{res['kalender_uri']}{uid}.ics"
    async with httpx.AsyncClient(verify=False, timeout=20) as c:
        r = await c.put(url, auth=auth, content=ical.encode(),
                        headers={"Content-Type": "text/calendar; charset=utf-8", "If-None-Match": "*"})
    if r.status_code not in (201, 204):
        raise HTTPException(status_code=502, detail=f"Buchung abgelehnt: {r.status_code} {r.text[:160]}")

    nachher = [b for b in await _belegung(res["kalender_uri"], von, bis) if b["uid"] != uid]
    if nachher:
        async with httpx.AsyncClient(verify=False, timeout=20) as c:
            await c.delete(url, auth=auth)
        raise HTTPException(status_code=409, detail={
            "meldung": f"{res['name']} wurde in derselben Sekunde von jemand anderem gebucht",
            "konflikte": nachher})
    return {"ok": True, "uid": uid, "ressource": res["name"],
            "von": von.astimezone(LOCAL_TZ).isoformat(), "bis": bis.astimezone(LOCAL_TZ).isoformat()}


def _esc(t: str) -> str:
    return (t or "").replace("\\", "\\\\").replace(";", r"\;").replace(",", r"\,").replace("\n", r"\n")


@router.delete("/ressourcen/{rid}/buchung/{uid}")
async def ressource_stornieren(rid: str, uid: str, request: Request):
    user = require_caller(request)
    if not re.fullmatch(r"[A-Za-z0-9@._-]{1,200}", uid) or ".." in uid:
        raise HTTPException(status_code=400, detail="Ungültige Buchungskennung")
    res = await _ressource(rid)
    from routers.teams_admin import NEXTCLOUD_URL, _nc_admin_auth
    auth = await _nc_admin_auth()
    url = f"{NEXTCLOUD_URL}{res['kalender_uri']}{uid}.ics"
    async with httpx.AsyncClient(verify=False, timeout=20) as c:
        # Only the person who booked (ORGANIZER) or an administrator may cancel —
        # booking ids are visible to everyone in the occupancy view.
        cur = await c.get(url, auth=auth)
        if cur.status_code == 200:
            m = re.search(r"^ORGANIZER[^:\r\n]*:(?:mailto:)?([^@\r\n]+)", cur.text, re.M | re.I)
            if (m.group(1).strip() if m else "") != user:
                _admin_pflicht(request)
        r = await c.delete(url, auth=auth)
    if r.status_code not in (200, 204, 404):
        raise HTTPException(status_code=502, detail=f"Stornierung abgelehnt: {r.status_code}")
    logger.info("Ressource %s: Buchung %s storniert von %s", rid, uid, user)
    return {"ok": True, "storniert": r.status_code in (200, 204)}


@router.delete("/ressourcen/{rid}")
async def ressource_entfernen(rid: str, request: Request,
                              kalender_loeschen: bool = Query(False)):
    """Retire a resource.

    Important: the calendar is kept by default. The resource disappears from
    the selection, but its past is part of the household history ("when was the
    car last inspected?"). Anyone who really wants everything gone has to say
    so explicitly.
    """
    require_caller(request)
    _admin_pflicht(request)
    res = await _ressource(rid)
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("UPDATE claraos_ressourcen SET aktiv = FALSE WHERE id = $1", rid)
    kalender_weg = False
    hinweis = None
    if kalender_loeschen:
        from routers.teams_admin import nc_calendar_delete
        await nc_calendar_delete(res["kalender_uri"])
        # Warning: Nextcloud answers a calendar delete with **204, yet the
        # calendar is still listed afterwards** (it goes to the trash bin;
        # `occ dav:list-calendars` still shows it; only
        # `occ dav:delete-calendar -f` removes it).
        # So we check instead of trusting the response: a "deleted" that
        # deleted nothing is worse than an honest "in the trash bin".
        kalender_weg = not await _kalender_existiert(res["kalender_uri"])
        if not kalender_weg:
            hinweis = ("Nextcloud hat den Kalender in den Papierkorb gelegt, nicht entfernt. "
                       "Endgültig löschen geht nur am Server: "
                       f"occ dav:delete-calendar -f clara.bot {res['kalender_uri'].strip('/').split('/')[-1]}")
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM claraos_ressourcen WHERE id = $1", rid)
    return {"ok": True, "id": rid, "kalender_geloescht": kalender_weg, "hinweis": hinweis}


async def _kalender_existiert(uri: str) -> bool:
    """Is this calendar still in its owner's collection?"""
    from routers.teams_admin import NEXTCLOUD_URL, _nc_admin_auth
    heim = uri.rsplit("/", 2)[0] + "/"
    auth = await _nc_admin_auth()
    try:
        async with httpx.AsyncClient(verify=False, timeout=20) as c:
            r = await c.request("PROPFIND", NEXTCLOUD_URL + heim, auth=auth, headers={"Depth": "1"})
        return uri in r.text
    except Exception as e:            # when in doubt, claim nothing
        logger.warning("Kalender-Nachschau %s: %s", uri, e)
        return True


# ── Meeting poll ─────────────────────────────────────────────────────────────

class UmfrageIn(BaseModel):
    titel: str
    ort: str = ""
    dauer_min: int = 60
    optionen: list[str]           # ISO start times
    teilnehmer: list[str] = []    # ClaraOS usernames


@router.post("/umfragen")
async def umfrage_anlegen(body: UmfrageIn, request: Request):
    user = require_caller(request)
    await _ensure_tables()
    if len(body.optionen) < 2:
        raise HTTPException(status_code=400, detail="Eine Umfrage braucht mindestens zwei Vorschläge")
    if len(body.optionen) > 12:
        raise HTTPException(status_code=400, detail="Mehr als zwölf Vorschläge beantwortet niemand")
    optionen = [_parse_iso(o, "Vorschlag").astimezone(LOCAL_TZ).isoformat() for o in body.optionen]
    uid = uuid.uuid4().hex[:12]
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            INSERT INTO claraos_terminumfrage (id, ersteller, titel, ort, dauer_min, optionen, teilnehmer)
            VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
        """, uid, user, body.titel.strip(), body.ort.strip(), max(15, body.dauer_min),
             json.dumps(optionen), json.dumps(body.teilnehmer))
    return {"ok": True, "id": uid, "optionen": optionen}


@router.get("/umfragen")
async def umfragen(request: Request):
    """Polls relevant to the caller: own ones and those the caller participates in."""
    user = require_caller(request)
    await _ensure_tables()
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT id, ersteller, titel, ort, dauer_min, optionen, teilnehmer, status, gewaehlt, erstellt_am
            FROM claraos_terminumfrage
            WHERE ersteller = $1 OR teilnehmer ? $1
            ORDER BY erstellt_am DESC LIMIT 50
        """, user)
        meine = await conn.fetch("SELECT umfrage_id FROM claraos_terminumfrage_stimme WHERE person = $1", user)
    abgestimmt = {r["umfrage_id"] for r in meine}
    out = []
    for r in rows:
        d = dict(r)
        d["optionen"] = _jsonb(d["optionen"])
        d["teilnehmer"] = _jsonb(d["teilnehmer"])
        d["erstellt_am"] = d["erstellt_am"].isoformat()
        d["habe_abgestimmt"] = r["id"] in abgestimmt
        out.append(d)
    return {"umfragen": out}


def _jsonb(v: Any) -> Any:
    return json.loads(v) if isinstance(v, str) else v


@router.get("/umfragen/{uid}")
async def umfrage(uid: str, request: Request):
    """A poll with the tally per proposal."""
    user = require_caller(request)
    await _ensure_tables()
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM claraos_terminumfrage WHERE id = $1", uid)
        if not row:
            raise HTTPException(status_code=404, detail="Umfrage nicht gefunden")
        stimmen = await conn.fetch("SELECT person, option_idx, antwort FROM claraos_terminumfrage_stimme "
                                   "WHERE umfrage_id = $1", uid)
    optionen = _jsonb(row["optionen"])
    zaehler = [{"ja": 0, "vielleicht": 0, "nein": 0} for _ in optionen]
    je_person: dict[str, dict[int, str]] = {}
    for s in stimmen:
        if 0 <= s["option_idx"] < len(zaehler) and s["antwort"] in zaehler[s["option_idx"]]:
            zaehler[s["option_idx"]][s["antwort"]] += 1
        je_person.setdefault(s["person"], {})[s["option_idx"]] = s["antwort"]
    # "Best" proposal: yes counts fully, maybe half, a no weighs heavily;
    # a slot at which someone cannot attend is not a good slot.
    punkte = [z["ja"] + 0.5 * z["vielleicht"] - 1.5 * z["nein"] for z in zaehler]
    bester = max(range(len(punkte)), key=lambda i: punkte[i]) if punkte else None
    return {"umfrage": {"id": row["id"], "ersteller": row["ersteller"], "titel": row["titel"],
                        "ort": row["ort"], "dauer_min": row["dauer_min"], "optionen": optionen,
                        "teilnehmer": _jsonb(row["teilnehmer"]), "status": row["status"],
                        "gewaehlt": row["gewaehlt"]},
            "auszaehlung": zaehler, "je_person": je_person, "empfehlung": bester,
            "ich": user, "meine_stimmen": je_person.get(user, {})}


class StimmeIn(BaseModel):
    stimmen: dict[int, str]       # proposal index -> ja | vielleicht | nein


@router.post("/umfragen/{uid}/stimme")
async def umfrage_stimme(uid: str, body: StimmeIn, request: Request):
    user = require_caller(request)
    await _ensure_tables()
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT optionen, status FROM claraos_terminumfrage WHERE id = $1", uid)
        if not row:
            raise HTTPException(status_code=404, detail="Umfrage nicht gefunden")
        if row["status"] != "offen":
            raise HTTPException(status_code=409, detail="Diese Umfrage ist abgeschlossen")
        anzahl = len(_jsonb(row["optionen"]))
        for idx, antwort in body.stimmen.items():
            if not (0 <= int(idx) < anzahl):
                raise HTTPException(status_code=400, detail=f"Vorschlag {idx} gibt es nicht")
            if antwort not in ("ja", "vielleicht", "nein"):
                raise HTTPException(status_code=400, detail=f"Antwort {antwort!r} kenne ich nicht")
        async with conn.transaction():
            await conn.execute("DELETE FROM claraos_terminumfrage_stimme WHERE umfrage_id = $1 AND person = $2",
                               uid, user)
            for idx, antwort in body.stimmen.items():
                await conn.execute("INSERT INTO claraos_terminumfrage_stimme (umfrage_id, person, option_idx, antwort) "
                                   "VALUES ($1,$2,$3,$4)", uid, user, int(idx), antwort)
    return {"ok": True, "stimmen": len(body.stimmen)}


class FestlegenIn(BaseModel):
    option_idx: int


@router.post("/umfragen/{uid}/festlegen")
async def umfrage_festlegen(uid: str, body: FestlegenIn, request: Request):
    """Close the poll and turn the chosen proposal into an event.

    The event is created via the planner's existing calendar path, so
    invitations, reminders and display work exactly as usual, rather than as a
    second, half-maintained kind of event alongside.
    """
    user = require_caller(request)
    await _ensure_tables()
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM claraos_terminumfrage WHERE id = $1", uid)
        if not row:
            raise HTTPException(status_code=404, detail="Umfrage nicht gefunden")
        if row["ersteller"] != user:
            raise HTTPException(status_code=403, detail="Nur wer die Umfrage gestartet hat, legt sie fest")
        optionen = _jsonb(row["optionen"])
        if not (0 <= body.option_idx < len(optionen)):
            raise HTTPException(status_code=400, detail="Diesen Vorschlag gibt es nicht")
        start = _parse_iso(optionen[body.option_idx], "Vorschlag")
        ende = start + timedelta(minutes=row["dauer_min"])

    # Important: participants are usernames here, but the calendar needs
    # addresses, and exactly the same ones the planner calendar uses
    # (Nextcloud address book before Authentik before fallback). A second
    # address source would create address drift.
    from routers.planner_kalender import _address_of
    from routers.post import _internal
    teilnehmer = []
    for person in _jsonb(row["teilnehmer"]):
        adresse = await _address_of(person)
        if adresse:
            teilnehmer.append({"email": adresse, "name": person})
    async with _internal(user) as cl:
        r = await cl.post("/api/claraos/planner/events", json={
            "summary": row["titel"], "start": start.isoformat(), "end": ende.isoformat(),
            "location": row["ort"] or None,
            "attendees": teilnehmer,
            "description": f"Aus der Terminumfrage vom {row['erstellt_am'].strftime('%d.%m.%Y')}",
        })
    angelegt = r.status_code in (200, 201)
    if not angelegt:
        logger.warning("Umfrage %s: Termin nicht angelegt (%s) %s", uid, r.status_code, r.text[:200])

    async with pool.acquire() as conn:
        await conn.execute("UPDATE claraos_terminumfrage SET status = 'entschieden', gewaehlt = $2 WHERE id = $1",
                           uid, body.option_idx)
    return {"ok": True, "termin_angelegt": angelegt,
            "hinweis": None if angelegt else "Die Umfrage ist entschieden, der Termin muss von Hand angelegt werden",
            "start": start.isoformat(), "ende": ende.isoformat()}


@router.delete("/umfragen/{uid}")
async def umfrage_loeschen(uid: str, request: Request):
    """Delete a poll with its votes; only its creator may do so."""
    user = require_caller(request)
    await _ensure_tables()
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT ersteller FROM claraos_terminumfrage WHERE id = $1", uid)
        if not row:
            raise HTTPException(status_code=404, detail="Umfrage nicht gefunden")
        if row["ersteller"] != user:
            raise HTTPException(status_code=403, detail="Nur wer die Umfrage gestartet hat, darf sie löschen")
        async with conn.transaction():
            await conn.execute("DELETE FROM claraos_terminumfrage_stimme WHERE umfrage_id = $1", uid)
            await conn.execute("DELETE FROM claraos_terminumfrage WHERE id = $1", uid)
    return {"ok": True}


# ── Booking page ("book a slot with me") ──────────────────────────────────

class BuchungsseiteIn(BaseModel):
    aktiv: bool = True
    dauer_min: int = 30
    von_uhr: int = 9
    bis_uhr: int = 18
    werktags: bool = True
    titel: str = "Termin"
    hinweis: str = ""


@router.get("/buchungsseite")
async def buchungsseite_eigene(request: Request):
    """The caller's own booking page: on or off, and at which times."""
    user = require_caller(request)
    return {"einstellung": await _buchungsseite(user) or {
        "aktiv": False, "dauer_min": 30, "von_uhr": 9, "bis_uhr": 18,
        "werktags": True, "titel": "Termin", "hinweis": ""}}


@router.put("/buchungsseite")
async def buchungsseite_setzen(body: BuchungsseiteIn, request: Request):
    """Deliberately off until someone turns it on.

    A booking page lets others write events into the owner's calendar. That
    must be a decision, not a side effect of an update.
    """
    user = require_caller(request)
    if not (0 <= body.von_uhr < body.bis_uhr <= 24):
        raise HTTPException(status_code=400, detail="Zeitfenster ungültig")
    await _ensure_tables()
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            INSERT INTO claraos_buchungsseite (username, aktiv, dauer_min, von_uhr, bis_uhr, werktags, titel, hinweis)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT (username) DO UPDATE SET aktiv = EXCLUDED.aktiv, dauer_min = EXCLUDED.dauer_min,
              von_uhr = EXCLUDED.von_uhr, bis_uhr = EXCLUDED.bis_uhr, werktags = EXCLUDED.werktags,
              titel = EXCLUDED.titel, hinweis = EXCLUDED.hinweis
        """, user, body.aktiv, max(15, body.dauer_min), body.von_uhr, body.bis_uhr,
             body.werktags, body.titel.strip() or "Termin", body.hinweis.strip())
    return {"ok": True}


async def _buchungsseite(username: str) -> dict[str, Any] | None:
    await _ensure_tables()
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM claraos_buchungsseite WHERE username = $1", username)
    return dict(row) if row else None


@router.get("/buchungsseite/{gastgeber}/zeiten")
async def buchungsseite_zeiten(gastgeber: str, request: Request,
                               tage: int = Query(14, ge=1, le=60)):
    """Free slots of the host, derived from their real free/busy data.

    Important: **no** event details are transferred, only busy/free. Being
    allowed to book a slot does not mean being allowed to read the calendar.
    """
    require_caller(request)
    einst = await _buchungsseite(gastgeber)
    if not einst or not einst["aktiv"]:
        raise HTTPException(status_code=404, detail=f"{gastgeber} bietet keine Terminbuchung an")

    from routers.planner_kalender import _busy_of_user
    jetzt = datetime.now(LOCAL_TZ)
    start = jetzt.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    ende = (jetzt + timedelta(days=tage)).replace(hour=23, minute=59)
    belegt_roh = await _busy_of_user(gastgeber, start, ende)
    if belegt_roh is None:
        raise HTTPException(status_code=502, detail=f"Der Kalender von {gastgeber} ist gerade nicht lesbar")

    belegt = [(_parse_iso(b["start"], "start"), _parse_iso(b["end"], "end")) for b in belegt_roh]
    dauer = timedelta(minutes=einst["dauer_min"])
    frei: list[dict[str, str]] = []
    cur = start
    while cur + dauer <= ende and len(frei) < 60:
        if einst["werktags"] and cur.weekday() >= 5:
            cur = (cur + timedelta(days=1)).replace(hour=einst["von_uhr"], minute=0)
            continue
        if cur.hour < einst["von_uhr"]:
            cur = cur.replace(hour=einst["von_uhr"], minute=0)
            continue
        schluss = cur + dauer
        if schluss.hour > einst["bis_uhr"] or schluss.date() != cur.date():
            cur = (cur + timedelta(days=1)).replace(hour=einst["von_uhr"], minute=0)
            continue
        kollision = next((b for b in belegt if b[0] < schluss and b[1] > cur), None)
        if kollision:
            cur = max(kollision[1].astimezone(LOCAL_TZ), cur + timedelta(minutes=15))
            continue
        frei.append({"von": cur.isoformat(), "bis": schluss.isoformat()})
        cur = schluss
    return {"gastgeber": gastgeber, "dauer_min": einst["dauer_min"],
            "titel": einst["titel"], "hinweis": einst["hinweis"], "zeiten": frei}


class TerminBuchenIn(BaseModel):
    von: str
    thema: str = ""


@router.post("/buchungsseite/{gastgeber}/buchen")
async def buchungsseite_buchen(gastgeber: str, body: TerminBuchenIn, request: Request):
    """Book a slot with the host.

    Important: the slot is **checked again when booking**, not only when
    displayed. Minutes often pass between loading the list and the click,
    enough for another event to appear.
    """
    gast = require_caller(request)
    einst = await _buchungsseite(gastgeber)
    if not einst or not einst["aktiv"]:
        raise HTTPException(status_code=404, detail=f"{gastgeber} bietet keine Terminbuchung an")
    start = _parse_iso(body.von, "von")
    ende = start + timedelta(minutes=einst["dauer_min"])
    if start < datetime.now(LOCAL_TZ):
        raise HTTPException(status_code=400, detail="Das liegt in der Vergangenheit")

    from routers.planner_kalender import _address_of, _busy_of_user
    belegt = await _busy_of_user(gastgeber, start, ende)
    if belegt is None:
        raise HTTPException(status_code=502, detail=f"Der Kalender von {gastgeber} ist gerade nicht lesbar")
    if belegt:
        raise HTTPException(status_code=409, detail="Dieses Zeitfenster ist inzwischen vergeben")

    gast_adresse = await _address_of(gast)
    from routers.post import _internal
    async with _internal(gastgeber) as cl:                    # the event belongs to the host
        r = await cl.post("/api/claraos/planner/events", json={
            "summary": f"{einst['titel']} mit {gast}",
            "start": start.isoformat(), "end": ende.isoformat(),
            "description": (body.thema.strip() or "") + f"\n(Gebucht über die Buchungsseite von {gastgeber})",
            "attendees": [{"email": gast_adresse, "name": gast}] if gast_adresse else [],
        })
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=f"Termin nicht angelegt: {r.status_code} {r.text[:160]}")
    return {"ok": True, "von": start.isoformat(), "bis": ende.isoformat(), "gastgeber": gastgeber}


@router.get("/buchungsseiten")
async def buchungsseiten(request: Request):
    """Who offers slot booking at all?"""
    require_caller(request)
    await _ensure_tables()
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT username, dauer_min, titel, hinweis FROM claraos_buchungsseite "
                                "WHERE aktiv ORDER BY username")
    return {"gastgeber": [dict(r) for r in rows]}


# ── Meeting room (online meeting) ──────────────────────────────────────────

class BesprechungIn(BaseModel):
    titel: str
    teilnehmer: list[str] = []    # ClaraOS usernames


@router.post("/besprechung")
async def besprechung_anlegen(body: BesprechungIn, request: Request):
    """Create a Matrix room for a meeting and return the link.

    Important: the link points into the **Teams app at this room**, not at the
    Element Call host. Element Call without a room and without a widget frame
    is just a login screen; the call lives in the room.

    Limitation, stated openly: anyone without a ClaraOS account cannot join
    this room. There is nothing here for external guests; that would be a
    separate path (guest access), not a by-product of this endpoint.
    """
    user = require_caller(request)
    from routers.teams_admin import (MATRIX_DOMAIN, SYNAPSE_URL, _get_synapse_admin_token,
                                     mx_invite_user)
    token = await _get_synapse_admin_token()
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post(f"{SYNAPSE_URL}/_matrix/client/v3/createRoom",
                         headers={"Authorization": f"Bearer {token}"},
                         json={"name": f"Besprechung: {body.titel}"[:120],
                               "topic": f"Angelegt von {user} über den Planner",
                               "preset": "private_chat", "visibility": "private"})
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Matrix lehnt den Raum ab: {r.status_code} {r.text[:160]}")
    room_id = r.json()["room_id"]

    eingeladen, ohne_konto = [], []
    for person in {*body.teilnehmer, user}:
        try:
            await mx_invite_user(room_id, person)
            eingeladen.append(person)
        except Exception as e:       # a missing identity must not break the meeting
            logger.info("Besprechung %s: %s nicht eingeladen (%s)", room_id, person, e)
            ohne_konto.append(person)

    link = f"https://{BASE_DOMAIN}/?app=teams&room={room_id}"
    return {"ok": True, "room_id": room_id, "link": link,
            "matrix_to": f"https://matrix.to/#/{room_id}?via={MATRIX_DOMAIN}",
            "eingeladen": sorted(eingeladen), "ohne_matrix_konto": sorted(ohne_konto),
            "hinweis": "Der Link öffnet die Teams-App auf diesem Raum; der Anruf startet dort. "
                       f"Gäste ohne {PRODUCT_NAME}-Konto können nicht teilnehmen."}
