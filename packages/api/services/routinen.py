"""Routines — recurring tasks for Clara, run through the external brain.

A routine is a standing instruction with a rhythm ("every weekday at 07:00: summarise
my inbox and today's tasks"). Each run:
  1. gets its own brain turn, marked {"art": "routine", "lauf": <run id>}
     (services/brain_turns.py) — the brain learns the user only from the turn;
  2. is sent to the cell's LiteLLM alias `clara/everyday` (which forwards to the brain)
     like a chat message, but nobody watches it live;
  3. may only READ: routers/clara_tools.call_tool asks `erlaubt()` for every tool call
     of a routine turn. Anything not on the read list is NOT executed but stored on the
     run as a proposal; the owner approves or discards it in the Routines app.
     Unknown tools count as changing — a new tool nobody classified needs approval.
  4. ends as a notification in the shell's bell (`melden`).

No cron syntax for users: rhythm = daily | weekdays | weekly | hourly plus a time.
"""
from __future__ import annotations

from betriebsprofil import ASSISTANT_NAME
import asyncio
import datetime as dt
import json
import logging
import os

import httpx

from services import brain_turns

logger = logging.getLogger(__name__)

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo(os.environ.get("CLARAOS_TZ", "Europe/Berlin"))
except Exception:  # noqa: BLE001
    TZ = dt.timezone.utc

LITELLM_URL = os.environ.get("LITELLM_BASE_URL", "").rstrip("/")
LITELLM_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
MODELL = os.environ.get("CLARAOS_ROUTINE_MODEL", "clara/everyday")
# Same situation as the chat (routers/chat_v2.py): the run goes to the agent behind
# `clara/everyday`, which picks its model itself — a class could not be enforced
# here. The declaration marks the place where it has to arrive once the agent
# accepts one; without it the gap would be invisible.
DATENKLASSE = "oeffentlich"
DATENKLASSE_ERZWUNGEN = False
MAX_SEKUNDEN = int(os.environ.get("CLARAOS_ROUTINE_TIMEOUT", "300"))

# Tools a routine may call without asking — they only read. Everything else (and every
# tool not listed here) becomes a proposal. Module = file name in clara-tools.d.
LESEN: dict[str, frozenset[str]] = {
    "planner": frozenset({"list_projects", "list_tasks", "count_tasks", "uebersicht", "get_task"}),
    "mail": frozenset({"list_messages", "count_messages", "get_message", "list_mailboxes",
                       "get_attachment"}),
    "nc-pim": frozenset({"list_events", "list_contacts"}),
    "knowledge": frozenset({"list_ideas", "get_object", "list_collections", "get_backlinks",
                            "query_collection", "list_templates", "get_backmentions",
                            "get_history", "search_knowledge_db", "list_goals"}),
    "lernen": frozenset({"gelernter_weg"}),
    "paperless": frozenset({"search_documents", "list_tags", "list_correspondents",
                            "read_document", "recent_documents"}),
    "routinen": frozenset({"list_routines"}),
    "peertube": frozenset({"search_videos", "recent_videos", "get_video"}),
    "dienste": frozenset({"list_services"}),
    "immich": frozenset({"search_photos", "list_albums", "list_people", "photo_statistics"}),
    "mastodon": frozenset({"get_timeline", "get_local_timeline", "get_notifications",
                           "my_account", "account_statuses", "search"}),
    "files": frozenset({"list_sources", "list_directory", "search_files", "read_file"}),
}

ANWEISUNG = (
    "Dies ist eine geplante Routine des Nutzers. Niemand liest gerade mit, du kannst "
    "nicht nachfragen. Du darfst Daten LESEN. Änderungen (Aufgaben anlegen, Mails "
    "senden, Termine eintragen …) führst du NICHT selbst aus: rufe das passende "
    "Werkzeug trotzdem auf — die Zelle speichert den Aufruf als Vorschlag, den der "
    "Nutzer freigibt. Antworte am Ende mit einer kurzen Zusammenfassung auf Deutsch, "
    "die als Meldung erscheint; nenne Vorschläge ausdrücklich."
)


def ist_lesend(modul: str, werkzeug: str) -> bool:
    return werkzeug in LESEN.get(modul, frozenset())


def faellig(r: dict, jetzt: dt.datetime) -> bool:
    """Is routine `r` due in the minute `jetzt` (local time)?"""
    hh, mm = (int(x) for x in (r.get("uhrzeit") or "07:00").split(":"))
    rh = r.get("rhythmus")
    if rh == "stuendlich":
        return jetzt.minute == mm
    if (jetzt.hour, jetzt.minute) != (hh, mm):
        return False
    if rh == "werktags":
        return jetzt.weekday() < 5
    if rh == "woechentlich":
        return jetzt.weekday() == (r.get("wochentag") or 0)
    return rh == "taeglich"


# ── Proposals: called by the tool gateway for a routine turn ──────────────────

async def vorschlag_merken(lauf_id: str, modul: str, werkzeug: str, argumente: dict) -> int:
    """Store a changing tool call on the run instead of executing it. Returns its index."""
    from database import get_pool
    eintrag = {"modul": modul, "werkzeug": werkzeug, "argumente": argumente, "status": "offen"}
    pool = await get_pool()
    async with pool.acquire() as conn:
        n = await conn.fetchval(
            """UPDATE claraos_routine_laeufe
               SET vorschlaege = vorschlaege || $2::jsonb
               WHERE id = $1::uuid RETURNING jsonb_array_length(vorschlaege)""",
            lauf_id, json.dumps([eintrag]))
    return int(n or 1) - 1


async def chat_vorschlag(username: str, modul: str, werkzeug: str, argumente: dict) -> tuple[str, int]:
    """A tool call from the chat that needs the user's approval (`freigabe: true`).
    Stored as a run without a routine; a bell notification leads to it."""
    from database import user_tx
    eintrag = {"modul": modul, "werkzeug": werkzeug, "argumente": argumente, "status": "offen"}
    async with user_tx(username) as conn:
        lauf_id = str(await conn.fetchval(
            """INSERT INTO claraos_routine_laeufe (routine_id, username, status, ergebnis, beendet, vorschlaege)
               VALUES (NULL, $1, 'wartet', 'Aus dem Chat', NOW(), $2::jsonb) RETURNING id""",
            username, json.dumps([eintrag])))
    await melden(username, f"{ASSISTANT_NAME} wartet auf deine Freigabe",
                 f"{werkzeug.replace('_', ' ')} ({modul}) — in „Routinen“ freigeben oder verwerfen.")
    return lauf_id, 0


async def melden(username: str, titel: str, text: str, app: str | None = "clara-routinen") -> None:
    """A notification in the user's bell (routers/meldungen.py)."""
    from database import get_pool
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO claraos_meldungen (username, titel, text, app) VALUES ($1, $2, $3, $4)",
            username, titel[:200], text[:4000], app)


# ── One run ───────────────────────────────────────────────────────────────────

async def ausfuehren(routine: dict) -> str:
    """Run a routine now. Returns the run id."""
    from database import get_pool
    pool = await get_pool()
    async with pool.acquire() as conn:
        lauf_id = str(await conn.fetchval(
            """INSERT INTO claraos_routine_laeufe (routine_id, username) VALUES ($1::uuid, $2)
               RETURNING id""", str(routine["id"]), routine["username"]))
        await conn.execute("UPDATE claraos_routinen SET letzter_lauf = NOW() WHERE id = $1::uuid",
                           str(routine["id"]))
    user = routine["username"]
    turn = brain_turns.issue(user, {"art": "routine", "lauf": lauf_id})
    inhalt = (f"[ClaraOS context] chat_turn: {turn}; chat_user: {user}\n\n"
              f"{ANWEISUNG}\n\nRoutine „{routine['titel']}“:\n{routine['auftrag']}")
    status, ergebnis = "fehler", ""
    try:
        if not (LITELLM_URL and LITELLM_KEY and brain_turns.enabled()):
            raise RuntimeError("kein Gehirn angebunden")
        async with httpx.AsyncClient(timeout=MAX_SEKUNDEN) as c:
            r = await c.post(f"{LITELLM_URL}/v1/chat/completions",
                             headers={"Authorization": f"Bearer {LITELLM_KEY}"},
                             json={"model": MODELL, "stream": False, "user": user,
                                   "messages": [{"role": "user", "content": inhalt}]})
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}")
        ergebnis = ((r.json().get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        status = "fertig"
    except Exception as exc:  # noqa: BLE001 — a failed run is recorded, never raised
        ergebnis = f"Die Routine konnte nicht ausgeführt werden ({exc})."
        logger.warning("routine %s: %s", routine["id"], exc)
    finally:
        brain_turns.end(turn)
    async with pool.acquire() as conn:
        offen = await conn.fetchval(
            """SELECT COUNT(*) FROM claraos_routine_laeufe, jsonb_array_elements(vorschlaege) v
               WHERE id = $1::uuid AND v->>'status' = 'offen'""", lauf_id)
        if status == "fertig" and offen:
            status = "wartet"
        await conn.execute(
            """UPDATE claraos_routine_laeufe SET status = $2, ergebnis = $3, beendet = NOW()
               WHERE id = $1::uuid""", lauf_id, status, ergebnis[:20000])
    titel = {"fertig": routine["titel"], "wartet": f"{routine['titel']} — Freigabe nötig",
             "fehler": f"{routine['titel']} — fehlgeschlagen"}[status]
    await melden(user, titel, ergebnis[:600] or "(ohne Text)")
    return lauf_id


async def vorschlag_ausfuehren(username: str, lauf_id: str, index: int, freigeben: bool) -> dict:
    """Owner decision on one proposal: execute it (through the tool gateway, as the
    owner) or discard it."""
    from database import user_tx
    async with user_tx(username) as conn:
        row = await conn.fetchrow(
            "SELECT vorschlaege FROM claraos_routine_laeufe WHERE id = $1::uuid", lauf_id)
    if not row:
        raise LookupError("Lauf nicht gefunden")
    liste = row["vorschlaege"] if isinstance(row["vorschlaege"], list) else json.loads(row["vorschlaege"])
    if not 0 <= index < len(liste) or liste[index].get("status") != "offen":
        raise LookupError("Vorschlag nicht offen")
    v = liste[index]
    if freigeben:
        token = os.environ.get("CLARAOS_SERVICE_TOKEN", "")
        async with httpx.AsyncClient(timeout=120) as c:
            r = await c.post(f"http://127.0.0.1:8090/api/claraos/tools/call/{v['modul']}/{v['werkzeug']}",
                             json=v.get("argumente") or {},
                             headers={"X-ClaraOS-Service-Token": token, "X-Claraos-User": username})
        try:
            antwort = r.json()
        except ValueError:
            antwort = {"_body": r.text[:500]}
        ok = r.status_code == 200 and not (isinstance(antwort, dict) and antwort.get("ok") is False)
        v.update(status="ausgefuehrt" if ok else "fehler", antwort=json.dumps(antwort)[:2000])
    else:
        v["status"] = "verworfen"
    liste[index] = v
    noch_offen = any(x.get("status") == "offen" for x in liste)
    async with user_tx(username) as conn:
        await conn.execute(
            """UPDATE claraos_routine_laeufe SET vorschlaege = $2::jsonb,
               status = CASE WHEN $3 THEN status ELSE 'erledigt' END WHERE id = $1::uuid""",
            lauf_id, json.dumps(liste), noch_offen)
    return v


# ── Scheduler ─────────────────────────────────────────────────────────────────

async def _tick(gestartet: set) -> None:
    from database import get_pool
    jetzt = dt.datetime.now(TZ).replace(second=0, microsecond=0)
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = [dict(r) for r in await conn.fetch("SELECT * FROM claraos_routinen WHERE aktiv")]
    for r in rows:
        schluessel = (str(r["id"]), jetzt.isoformat())
        if schluessel in gestartet or not faellig(r, jetzt):
            continue
        letzter = r.get("letzter_lauf")
        if letzter and letzter.astimezone(TZ).replace(second=0, microsecond=0) >= jetzt:
            continue          # already ran this minute (e.g. "run now" just before)
        gestartet.add(schluessel)
        asyncio.get_event_loop().create_task(ausfuehren(r))
    for alt in [k for k in gestartet if k[1] < (jetzt - dt.timedelta(hours=2)).isoformat()]:
        gestartet.discard(alt)


async def loop() -> None:
    logger.warning("routinen: Taktgeber gestartet (%s)", TZ)
    gestartet: set = set()
    while True:
        try:
            await _tick(gestartet)
        except Exception as exc:  # noqa: BLE001
            logger.warning("routinen tick: %s", exc)
        await asyncio.sleep(60 - dt.datetime.now().second + 1)
