"""Planner calendar: extended calendar features of the Outlook-style app.

Contents (all on Nextcloud CalDAV; access = the users' stored Nextcloud app
credentials from `claraos_app_credentials`):

- `/people`      – household members for the attendee picker (+ own addresses)
- `/freebusy`    – free/busy per person (CalDAV `free-busy-query`) + suggestions
- `/calendars/shares` (GET/POST) – share calendars with household members (`oc:share`)
- `/events/{uid}/respond` – accept/decline/tentatively accept an invitation + counter-proposal
- `/holidays`    – German public holidays (national + per state), computed
- Edit/delete a single occurrence of a series (RECURRENCE-ID override / EXDATE),
  called from `planner.update_event` / `planner.delete_event`
- `reminder_loop()` – VALARM reminders as ntfy push (started from main.py)

Important, free/busy: Nextcloud's schedule outbox only finds users who have an
email address in their Nextcloud account (calendar-user-address-set), and many
users have none. So we query each person's busy times with THEIR OWN stored
Nextcloud credentials via `free-busy-query`. That returns only time blocks, no
titles (exactly what Nextcloud would show any logged-in user via the outbox
anyway).
"""
from __future__ import annotations

import os
from domains_generated import BASE_DOMAIN  # per deployment: CLARAOS_BASE_DOMAIN
import asyncio
import logging
import re
import time
from datetime import date, datetime, timedelta, timezone
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from auth import require_caller
from database import get_pool, user_tx
from routers.files import NEXTCLOUD_INTERNAL_URL, _nc_credentials
from routers.nc_pim import (
    _REPORT_VEVENT_ALL, _blocks, _calendar_data_texts, _calendars, _dav,
    _first, _guard_conflict, _put_ical, _resolve_item, _unfold,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/planner", tags=["planner-kalender"])

_TZ = ZoneInfo("Europe/Berlin")
_MAIL_DOMAIN = os.environ.get("STALWART_MAIL_DOMAIN", BASE_DOMAIN)
_SERVICE_USERS = {"clara.bot", "clara-agent", "clara", "playwright-test", "sso-smoke", "admin"}


def _caller(request: Request) -> str:
    return require_caller(request)


def _fold(line: str) -> str:
    if len(line.encode("utf-8")) <= 75:
        return line
    out, cur = [], ""
    for ch in line:
        if len((cur + ch).encode("utf-8")) > 74:
            out.append(cur)
            cur = " " + ch
        else:
            cur += ch
    out.append(cur)
    return "\r\n".join(out)


def _esc(t: str) -> str:
    return (t or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def _iso_to_dt(iso: str) -> datetime:
    d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _stamp(d: datetime) -> str:
    return d.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


# ── People ──────────────────────────────────────────────────────────────────
_people_cache: tuple[float, list[dict]] = (0.0, [])


async def _people() -> list[dict]:
    """[{username, name, email}] – all human users who have stored Nextcloud
    credentials (only they can have events)."""
    global _people_cache
    if time.time() - _people_cache[0] < 300 and _people_cache[1]:
        return _people_cache[1]
    humans = {u["username"]: u["name"] for u in await _authentik_humans()}
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT DISTINCT username FROM claraos_app_credentials WHERE app_id = 'nextcloud' AND is_active = TRUE")
    out = []
    for r in rows:
        u = r["username"]
        if u in _SERVICE_USERS or (humans and u not in humans):
            continue
        out.append({"username": u, "name": humans.get(u) or u, "email": await _address_of(u)})
    out.sort(key=lambda p: p["name"].lower())
    _people_cache = (time.time(), out)
    return out


_ak_cache: tuple[float, list[dict]] = (0.0, [])


async def _authentik_humans() -> list[dict]:
    """[{username, name, email}] from Authentik (identity source). Unlike
    `ntfy_publish.list_human_people` this includes the email, which the
    calendar needs as the ATTENDEE address. Visible only to logged-in users."""
    global _ak_cache
    if time.time() - _ak_cache[0] < 300 and _ak_cache[1]:
        return _ak_cache[1]
    import httpx
    # Important: use `konto_art`, the SAME single rule as the digest and the
    # player list. Otherwise service/test accounts show up as selectable people
    # in the invitation field.
    from services.ntfy_publish import AUTHENTIK_TOKEN, AUTHENTIK_URL, konto_art
    if not AUTHENTIK_TOKEN:
        return []
    out: list[dict] = []
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{AUTHENTIK_URL}/api/v3/core/users/?page_size=200&is_active=true",
                                    headers={"Authorization": f"Bearer {AUTHENTIK_TOKEN}"})
        for u in (resp.json().get("results", []) if resp.status_code == 200 else []):
            if konto_art(u) != "mensch":
                continue
            out.append({"username": u["username"], "name": u.get("name") or u["username"],
                        "email": (u.get("email") or "").strip().lower()})
    except Exception as exc:  # noqa: BLE001
        logger.warning("planner_kalender _authentik_humans: %s", exc)
    if out:
        _ak_cache = (time.time(), out)
    return out


_addr_cache: dict[str, tuple[float, list[str]]] = {}


async def _addresses_of(username: str) -> list[str]:
    """Calendar addresses of a user, in this order: Nextcloud
    calendar-user-address-set (only that one matches Nextcloud's scheduling for
    internal delivery) -> Authentik email (identity source) ->
    <username>@<mail domain> as the last fallback. The first one is the ATTENDEE address."""
    hit = _addr_cache.get(username)
    if hit and time.time() - hit[0] < 600:
        return hit[1]
    addrs: list[str] = []
    try:
        nu, npw = await _nc_credentials(username)
        body = ('<?xml version="1.0" encoding="utf-8" ?><d:propfind xmlns:d="DAV:" '
                'xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-user-address-set/></d:prop></d:propfind>')
        resp = await _dav("PROPFIND", f"{NEXTCLOUD_INTERNAL_URL}/remote.php/dav/principals/users/{nu}/", nu, npw, body, depth="0")
        addrs = [m.lower() for m in re.findall(r"mailto:([^<\s]+)", resp.text or "")]
    except Exception as exc:  # noqa: BLE001
        logger.debug("planner_kalender _addresses_of %s: %s", username, exc)
    ak = next((u["email"] for u in await _authentik_humans() if u["username"] == username), "")
    for extra in (ak, f"{username}@{_MAIL_DOMAIN}".lower()):
        if extra and extra not in addrs:
            addrs.append(extra)
    _addr_cache[username] = (time.time(), addrs)
    return addrs


async def _address_of(username: str) -> str:
    return (await _addresses_of(username))[0]


@router.get("/people")
async def people(request: Request):
    me = _caller(request)
    return {"people": await _people(), "me": {"username": me, "addresses": await _addresses_of(me)}}


# ── Free/busy ─────────────────────────────────────────────────────────────
class FreeBusyIn(BaseModel):
    people: list[str]              # usernames
    start: str                     # ISO
    end: str
    duration_minutes: int = 60
    day_start_hour: int = 8
    day_end_hour: int = 18
    weekdays_only: bool = True


def _fb_report(start: datetime, end: datetime) -> str:
    return ('<?xml version="1.0" encoding="utf-8" ?><c:free-busy-query xmlns:c="urn:ietf:params:xml:ns:caldav">'
            f'<c:time-range start="{_stamp(start)}" end="{_stamp(end)}"/></c:free-busy-query>')


def _parse_freebusy(text: str) -> list[dict]:
    """FREEBUSY;FBTYPE=BUSY:20260908T070000Z/20260908T080000Z,... -> blocks."""
    out: list[dict] = []
    for line in _unfold(text):
        if not line.upper().startswith("FREEBUSY"):
            continue
        head, _, value = line.partition(":")
        fbtype = "BUSY"
        m = re.search(r"FBTYPE=([A-Z-]+)", head, re.I)
        if m:
            fbtype = m.group(1).upper()
        if fbtype == "FREE":
            continue
        for period in value.split(","):
            a, _, b = period.strip().partition("/")
            if not a or not b:
                continue
            try:
                s = datetime.strptime(a, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
                if b.startswith("P"):
                    mm = re.match(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?", b)
                    d, h, mi = (int(x) if x else 0 for x in (mm.groups() if mm else (0, 0, 0)))
                    e = s + timedelta(days=d, hours=h, minutes=mi)
                else:
                    e = datetime.strptime(b, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
            except ValueError:
                continue
            out.append({"start": s.isoformat().replace("+00:00", "Z"),
                        "end": e.isoformat().replace("+00:00", "Z"),
                        "status": "tentative" if fbtype == "BUSY-TENTATIVE" else "busy"})
    out.sort(key=lambda b: b["start"])
    return out


async def _busy_of_user(username: str, start: datetime, end: datetime) -> list[dict] | None:
    try:
        nu, npw = await _nc_credentials(username)
    except HTTPException:
        return None
    cals = await _calendars(nu, npw, "VEVENT")
    blocks: list[dict] = []
    for cal in cals:
        if "birthday" in cal["name"].lower() or "geburtstag" in cal["name"].lower():
            continue
        resp = await _dav("REPORT", cal["url"], nu, npw, _fb_report(start, end), depth="0")
        if resp.status_code == 200:
            blocks.extend(_parse_freebusy(resp.text))
    blocks.sort(key=lambda b: b["start"])
    return blocks


def _suggest(all_busy: list[dict], body: FreeBusyIn, start: datetime, end: datetime) -> list[dict]:
    """First 6 gaps in which EVERYONE is free (working hours, 15 min grid)."""
    dur = timedelta(minutes=max(15, body.duration_minutes))
    busy = [(_iso_to_dt(b["start"]), _iso_to_dt(b["end"])) for b in all_busy]
    out: list[dict] = []
    now = datetime.now(timezone.utc)
    cur = start.astimezone(_TZ)
    cur = cur.replace(minute=(cur.minute // 15) * 15, second=0, microsecond=0)
    limit = end.astimezone(_TZ)
    while cur + dur <= limit and len(out) < 6:
        if body.weekdays_only and cur.weekday() >= 5:
            cur = (cur + timedelta(days=1)).replace(hour=body.day_start_hour, minute=0)
            continue
        if cur.hour < body.day_start_hour:
            cur = cur.replace(hour=body.day_start_hour, minute=0)
            continue
        slot_end = cur + dur
        if slot_end.hour > body.day_end_hour or (slot_end.hour == body.day_end_hour and slot_end.minute > 0) or slot_end.date() != cur.date():
            cur = (cur + timedelta(days=1)).replace(hour=body.day_start_hour, minute=0)
            continue
        if cur < now:
            cur += timedelta(minutes=15)
            continue
        clash = next((b for b in busy if b[0] < slot_end and b[1] > cur), None)
        if clash:
            cur = max(clash[1].astimezone(_TZ), cur + timedelta(minutes=15))
            cur = cur.replace(minute=((cur.minute + 14) // 15) * 15 % 60, second=0, microsecond=0) if cur.minute % 15 else cur
            continue
        out.append({"start": cur.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "end": slot_end.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")})
        cur = slot_end
    return out


@router.post("/freebusy")
async def freebusy(body: FreeBusyIn, request: Request):
    me = _caller(request)
    known = {p["username"] for p in await _people()}
    known.add(me)
    wanted = [u for u in dict.fromkeys([me, *body.people]) if u in known]
    start, end = _iso_to_dt(body.start), _iso_to_dt(body.end)
    if end <= start or end - start > timedelta(days=62):
        raise HTTPException(status_code=400, detail="Zeitraum ungültig (max. 62 Tage)")
    results = await asyncio.gather(*[_busy_of_user(u, start, end) for u in wanted])
    people = []
    all_busy: list[dict] = []
    for u, blocks in zip(wanted, results):
        people.append({"username": u, "busy": blocks or [], "available": blocks is not None})
        all_busy.extend(blocks or [])
    return {"people": people, "suggestions": _suggest(all_busy, body, start, end)}


# ── Calendar sharing ──────────────────────────────────────────────────────
def _own_cal(cals: list[dict], nc_user: str, name: str) -> dict:
    prefix = f"/remote.php/dav/calendars/{nc_user}/"
    cal = next((c for c in cals if c["name"] == name), None)
    if not cal:
        raise HTTPException(status_code=404, detail=f"Kalender „{name}“ nicht gefunden")
    if prefix not in cal["url"]:
        raise HTTPException(status_code=403, detail="Nur eigene Kalender lassen sich freigeben")
    return cal


@router.get("/calendars/shares")
async def calendar_shares(request: Request, calendar: str):
    me = _caller(request)
    nu, npw = await _nc_credentials(me)
    cals = await _calendars(nu, npw, "VEVENT")
    cal = _own_cal(cals, nu, calendar)
    body = ('<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:o="http://owncloud.org/ns">'
            '<d:prop><o:invite/></d:prop></d:propfind>')
    resp = await _dav("PROPFIND", cal["url"], nu, npw, body, depth="0")
    shares = []
    # Nextcloud answers with prefix `oc:` (not `o:`), so parse prefix-agnostically.
    for m in re.finditer(r"<(?:\w+:)?user>(.*?)</(?:\w+:)?user>", resp.text or "", re.S):
        block = m.group(1)
        href = re.search(r"<(?:\w+:)?href>([^<]+)</(?:\w+:)?href>", block)
        cn = re.search(r"<(?:\w+:)?common-name>([^<]*)</(?:\w+:)?common-name>", block)
        access = "write" if re.search(r"<(?:\w+:)?read-write\s*/?>", block) else "read"
        principal = (href.group(1) if href else "").strip()
        username = principal.rsplit("/", 1)[-1].replace("principal:principals/users/", "")
        shares.append({"principal": principal, "username": username,
                       "name": (cn.group(1) if cn else "") or username, "access": access})
    return {"calendar": calendar, "shares": shares}


class ShareIn(BaseModel):
    calendar: str
    username: str
    access: Literal["read", "write"] = "read"
    remove: bool = False


@router.post("/calendars/shares")
async def calendar_share(body: ShareIn, request: Request):
    me = _caller(request)
    if body.username not in {p["username"] for p in await _people()}:
        raise HTTPException(status_code=400, detail="Unbekannte Person")
    nu, npw = await _nc_credentials(me)
    cals = await _calendars(nu, npw, "VEVENT")
    cal = _own_cal(cals, nu, body.calendar)
    href = f"principal:principals/users/{body.username}"
    if body.remove:
        xml = ('<?xml version="1.0"?><o:share xmlns:d="DAV:" xmlns:o="http://owncloud.org/ns">'
               f'<o:remove><d:href>{href}</d:href></o:remove></o:share>')
    else:
        rw = "<o:read-write/>" if body.access == "write" else ""
        xml = ('<?xml version="1.0"?><o:share xmlns:d="DAV:" xmlns:o="http://owncloud.org/ns">'
               f'<o:set><d:href>{href}</d:href><o:summary>{_esc(body.calendar)}</o:summary>{rw}</o:set></o:share>')
    resp = await _dav("POST", cal["url"], nu, npw, xml, depth="0")
    if resp.status_code not in (200, 204):
        raise HTTPException(status_code=502, detail=f"Nextcloud Freigabe fehlgeschlagen: {resp.status_code} {resp.text[:160]}")
    return {"ok": True, "message": "Freigabe entfernt" if body.remove else f"„{body.calendar}“ für {body.username} freigegeben"}


# ── Respond to invitation ───────────────────────────────────────────────────
class RespondIn(BaseModel):
    partstat: Literal["ACCEPTED", "TENTATIVE", "DECLINED"]
    comment: str | None = None
    proposed_start: str | None = None   # counter-proposal (ISO)
    proposed_end: str | None = None
    calendar: str | None = None


_PARTSTAT_DE = {"ACCEPTED": "zugesagt", "TENTATIVE": "mit Vorbehalt zugesagt", "DECLINED": "abgesagt"}


@router.post("/events/{uid}/respond")
async def respond(uid: str, body: RespondIn, request: Request):
    me = _caller(request)
    nu, npw = await _nc_credentials(me)
    cals = await _calendars(nu, npw, "VEVENT")
    if body.calendar:
        cals = [c for c in cals if c["name"] == body.calendar] or cals
    url, raw, etag = await _resolve_item(nu, npw, cals, _REPORT_VEVENT_ALL, "VEVENT", uid)
    mine = set(await _addresses_of(me))
    lines = _unfold(raw)
    changed = False
    organizer = None
    summary = ""
    out: list[str] = []
    stamp = _stamp(datetime.now(timezone.utc))
    for line in lines:
        key = line.split(":", 1)[0].split(";", 1)[0].upper()
        if key == "ORGANIZER":
            organizer = line.rsplit(":", 1)[-1].replace("mailto:", "").lower()
        if key == "SUMMARY" and not summary:
            summary = line.split(":", 1)[1]
        if key == "ATTENDEE":
            addr = line.rsplit(":", 1)[-1].replace("mailto:", "").lower().strip()
            if addr in mine:
                head = line.rsplit(":", 1)[0]
                head = re.sub(r";PARTSTAT=[^;:]+", "", head, flags=re.I)
                head = re.sub(r";RSVP=[^;:]+", "", head, flags=re.I)
                line = f"{head};PARTSTAT={body.partstat}:mailto:{addr}"
                changed = True
        if key == "DTSTAMP":
            line = f"DTSTAMP:{stamp}"
        out.append(line)
    if not changed:
        raise HTTPException(status_code=400, detail="Du stehst nicht als Teilnehmer in diesem Termin")
    await _put_ical(url, nu, npw, "\r\n".join(_fold(l) for l in out), etag, "Der Termin")

    # Organizer is a local user? Then also send a push (with comment/counter-proposal).
    notified = False
    if organizer:
        for p in await _people():
            if organizer in await _addresses_of(p["username"]) and p["username"] != me:
                from services.ntfy_publish import notify_users
                msg = f"{me} hat „{summary}“ {_PARTSTAT_DE[body.partstat]}."
                if body.proposed_start:
                    ps = _iso_to_dt(body.proposed_start).astimezone(_TZ).strftime("%d.%m. %H:%M")
                    pe = _iso_to_dt(body.proposed_end).astimezone(_TZ).strftime("%H:%M") if body.proposed_end else ""
                    msg += f" Vorschlag: {ps}{'–' + pe if pe else ''}."
                if body.comment:
                    msg += f" „{body.comment.strip()[:200]}“"
                try:
                    notified = bool(await notify_users([p["username"]], "Antwort auf Einladung", msg, app_id="planner"))
                except Exception as exc:  # noqa: BLE001
                    logger.warning("planner_kalender respond notify: %s", exc)
                break
    return {"ok": True, "partstat": body.partstat, "organizer_notified": notified}


# ── Single occurrence of a series ────────────────────────────────────────────────
def _master_dt_form(raw: str) -> tuple[str, str]:
    """(params, kind) of the master DTSTART: kind = date | tzid | utc | floating."""
    for blk in _blocks(raw, "VEVENT"):
        if _first(blk, "RECURRENCE-ID"):
            continue
        for k, p, v in blk:
            if k == "DTSTART":
                if "VALUE=DATE" in p.upper() or (len(v) == 8 and "T" not in v):
                    return ";VALUE=DATE", "date"
                m = re.search(r"TZID=([^;:]+)", p, re.I)
                if m:
                    return f";TZID={m.group(1)}", "tzid"
                return "", "utc" if v.endswith("Z") else "floating"
    return ";TZID=Europe/Berlin", "tzid"


def _rid_value(iso: str, params: str, kind: str) -> str:
    d = _iso_to_dt(iso)
    if kind == "date":
        return d.astimezone(_TZ).strftime("%Y%m%d")
    if kind == "tzid":
        tzname = re.search(r"TZID=([^;:]+)", params).group(1).strip('"')  # type: ignore[union-attr]
        try:
            tz = ZoneInfo(tzname)
        except Exception:
            tz = _TZ
        return d.astimezone(tz).strftime("%Y%m%dT%H%M%S")
    if kind == "utc":
        return _stamp(d)
    return d.astimezone(_TZ).strftime("%Y%m%dT%H%M%S")


def _drop_override(lines: list[str], rid_value: str) -> list[str]:
    """Remove an existing override block (RECURRENCE-ID = rid_value)."""
    out: list[str] = []
    buf: list[str] | None = None
    for line in lines:
        if line == "BEGIN:VEVENT":
            buf = [line]
            continue
        if buf is not None:
            buf.append(line)
            if line == "END:VEVENT":
                rid = next((l for l in buf if l.upper().startswith("RECURRENCE-ID")), "")
                if rid.rsplit(":", 1)[-1].strip() != rid_value:
                    out.extend(buf)
                buf = None
            continue
        out.append(line)
    return out


def _bump_sequence(lines: list[str]) -> list[str]:
    """SEQUENCE+1 and DTSTAMP in the master (first VEVENT without RECURRENCE-ID)."""
    out: list[str] = []
    in_master = False
    depth = 0
    done = False
    stamp = _stamp(datetime.now(timezone.utc))
    for i, line in enumerate(lines):
        if line == "BEGIN:VEVENT" and not done:
            blk_end = next((j for j in range(i, len(lines)) if lines[j] == "END:VEVENT"), len(lines))
            in_master = not any(l.upper().startswith("RECURRENCE-ID") for l in lines[i:blk_end])
            depth = 0
            out.append(line)
            continue
        if in_master:
            if line.startswith("BEGIN:"):
                depth += 1
            elif line.startswith("END:VEVENT"):
                in_master, done = False, True
                out.append(line)
                continue
            elif line.startswith("END:"):
                depth -= 1
            if depth == 0:
                key = line.split(":", 1)[0].split(";", 1)[0].upper()
                if key == "SEQUENCE":
                    try:
                        line = f"SEQUENCE:{int(line.split(':', 1)[1]) + 1}"
                    except ValueError:
                        line = "SEQUENCE:1"
                elif key in ("DTSTAMP", "LAST-MODIFIED"):
                    line = f"{key}:{stamp}"
        out.append(line)
    return out


def _insert_before_end(lines: list[str], block: list[str]) -> list[str]:
    idx = max(i for i, l in enumerate(lines) if l == "END:VCALENDAR")
    return lines[:idx] + block + lines[idx:]


async def update_single_occurrence(user: str, uid: str, calendar: str | None, recurrence_id: str,
                                   body, build_props) -> dict:
    """`body` = EventUpdate; `build_props(body, master_block)` returns the
    override's property lines (from planner.py, so the rules for
    DTSTART/DTEND/busy/VALARM stay the same)."""
    nu, npw = await _nc_credentials(user)
    cals = await _calendars(nu, npw, "VEVENT")
    if calendar:
        cals = [c for c in cals if c["name"] == calendar] or cals
    url, raw, etag = await _resolve_item(nu, npw, cals, _REPORT_VEVENT_ALL, "VEVENT", uid)
    params, kind = _master_dt_form(raw)
    rid = _rid_value(recurrence_id, params, kind)
    lines = _unfold(raw)
    master = next((b for b in _blocks(raw, "VEVENT") if not _first(b, "RECURRENCE-ID")), None)
    if master is None:
        raise HTTPException(status_code=404, detail="Serien-Master nicht gefunden")
    old = next((b for b in _blocks(raw, "VEVENT") if _first(b, "RECURRENCE-ID") and
                _first(b, "RECURRENCE-ID").strip() == rid), None)
    try:
        seq = int(_first(old or master, "SEQUENCE") or 0) + 1
    except ValueError:
        seq = 1
    stamp = _stamp(datetime.now(timezone.utc))
    block = ["BEGIN:VEVENT", f"UID:{uid}", f"RECURRENCE-ID{params}:{rid}",
             f"DTSTAMP:{stamp}", f"LAST-MODIFIED:{stamp}", f"SEQUENCE:{seq}"]
    block += build_props(body, master)
    block.append("END:VEVENT")
    lines = _drop_override(lines, rid)
    lines = _insert_before_end(lines, block)
    await _put_ical(url, nu, npw, "\r\n".join(_fold(l) for l in lines), etag, "Der Termin")
    return {"ok": True, "uid": uid, "recurrence_id": recurrence_id, "only_this": True}


async def delete_single_occurrence(user: str, uid: str, calendar: str | None, recurrence_id: str) -> dict:
    nu, npw = await _nc_credentials(user)
    cals = await _calendars(nu, npw, "VEVENT")
    if calendar:
        cals = [c for c in cals if c["name"] == calendar] or cals
    url, raw, etag = await _resolve_item(nu, npw, cals, _REPORT_VEVENT_ALL, "VEVENT", uid)
    params, kind = _master_dt_form(raw)
    rid = _rid_value(recurrence_id, params, kind)
    lines = _drop_override(_unfold(raw), rid)
    lines = _bump_sequence(lines)
    # EXDATE into the master (before its END:VEVENT, outside VALARM)
    out: list[str] = []
    placed = False
    depth = 0
    for line in lines:
        if not placed and line == "BEGIN:VEVENT":
            depth = 1
        elif not placed and depth and line.startswith("BEGIN:"):
            depth += 1
        elif not placed and depth and line.startswith("END:"):
            depth -= 1
            if depth == 0 and line == "END:VEVENT":
                out.append(f"EXDATE{params}:{rid}")
                placed = True
        out.append(line)
    await _put_ical(url, nu, npw, "\r\n".join(_fold(l) for l in out), etag, "Der Termin")
    return {"ok": True, "uid": uid, "recurrence_id": recurrence_id, "only_this": True}


# ── Holidays ───────────────────────────────────────────────────────────────
_STATES = {
    "BW": "Baden-Württemberg", "BY": "Bayern", "BE": "Berlin", "BB": "Brandenburg", "HB": "Bremen",
    "HH": "Hamburg", "HE": "Hessen", "MV": "Mecklenburg-Vorpommern", "NI": "Niedersachsen",
    "NW": "Nordrhein-Westfalen", "RP": "Rheinland-Pfalz", "SL": "Saarland", "SN": "Sachsen",
    "ST": "Sachsen-Anhalt", "SH": "Schleswig-Holstein", "TH": "Thüringen",
}


def _easter(year: int) -> date:
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    m = (32 + 2 * e + 2 * i - h - k) % 7
    n = (a + 11 * h + 22 * m) // 451
    month = (h + m - 7 * n + 114) // 31
    day = (h + m - 7 * n + 114) % 31 + 1
    return date(year, month, day)


def holidays_for(year: int, state: str = "") -> list[dict]:
    e = _easter(year)
    hol: list[tuple[date, str, set[str] | None]] = [
        (date(year, 1, 1), "Neujahr", None),
        (date(year, 1, 6), "Heilige Drei Könige", {"BW", "BY", "ST"}),
        (date(year, 3, 8), "Internationaler Frauentag", {"BE", "MV"}),
        (e - timedelta(days=2), "Karfreitag", None),
        (e + timedelta(days=1), "Ostermontag", None),
        (date(year, 5, 1), "Tag der Arbeit", None),
        (e + timedelta(days=39), "Christi Himmelfahrt", None),
        (e + timedelta(days=50), "Pfingstmontag", None),
        (e + timedelta(days=60), "Fronleichnam", {"BW", "BY", "HE", "NW", "RP", "SL"}),
        (date(year, 8, 15), "Mariä Himmelfahrt", {"SL"}),
        (date(year, 9, 20), "Weltkindertag", {"TH"}),
        (date(year, 10, 3), "Tag der Deutschen Einheit", None),
        (date(year, 10, 31), "Reformationstag", {"BB", "HB", "HH", "MV", "NI", "SN", "ST", "SH", "TH"}),
        (date(year, 11, 1), "Allerheiligen", {"BW", "BY", "NW", "RP", "SL"}),
        (date(year, 12, 25), "1. Weihnachtstag", None),
        (date(year, 12, 26), "2. Weihnachtstag", None),
    ]
    # Day of Repentance and Prayer: the Wednesday before Nov 23
    d = date(year, 11, 22)
    while d.weekday() != 2:
        d -= timedelta(days=1)
    hol.append((d, "Buß- und Bettag", {"SN"}))
    out = [{"date": dd.isoformat(), "name": name, "regional": states is not None}
           for dd, name, states in hol if states is None or (state and state in states)]
    out.sort(key=lambda h: h["date"])
    return out


@router.get("/holidays")
async def holidays(request: Request, year: int, state: str = ""):
    _caller(request)
    state = state.upper()
    if state and state not in _STATES:
        raise HTTPException(status_code=400, detail="Unbekanntes Bundesland")
    return {"year": year, "state": state, "holidays": holidays_for(year, state),
            "states": [{"code": k, "name": v} for k, v in _STATES.items()]}


# ── Reminders -> ntfy ──────────────────────────────────────────────────────
_reminder_table_ready = False
_agenda_cache: dict[str, tuple[float, list[dict]]] = {}
_AGENDA_TTL = 300  # s
_AGENDA_WINDOW_H = 30


async def _ensure_reminder_table() -> None:
    global _reminder_table_ready
    if _reminder_table_ready:
        return
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_planner_reminders (
                username TEXT NOT NULL,
                key      TEXT NOT NULL,
                sent_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (username, key)
            )
        """)
    _reminder_table_ready = True


async def _push_enabled(username: str) -> bool:
    import json
    async with user_tx(username) as conn:
        row = await conn.fetchrow("SELECT prefs FROM claraos_user_prefs WHERE username = $1", username)
    try:
        prefs = json.loads(row["prefs"]) if row and row["prefs"] else {}
    except Exception:  # noqa: BLE001
        prefs = {}
    return bool((prefs.get("planner_app") or {}).get("reminders_push", True))


async def _agenda_with_alarms(username: str) -> list[dict]:
    """Events in the next 30 h that have a reminder (cached 5 min)."""
    hit = _agenda_cache.get(username)
    if hit and time.time() - hit[0] < _AGENDA_TTL:
        return hit[1]
    from routers.planner import _event_out, _report_events_expanded
    nu, npw = await _nc_credentials(username)
    now = datetime.now(timezone.utc)
    rep = _report_events_expanded(_stamp(now - timedelta(hours=1)), _stamp(now + timedelta(hours=_AGENDA_WINDOW_H)))
    items: list[dict] = []
    for cal in await _calendars(nu, npw, "VEVENT"):
        resp = await _dav("REPORT", cal["url"], nu, npw, rep)
        if resp.status_code != 207:
            continue
        for ics in _calendar_data_texts(resp):
            for blk in _blocks(ics, "VEVENT"):
                try:
                    ev = _event_out(blk, cal)
                except Exception:  # noqa: BLE001
                    continue
                if ev.get("alarm_minutes") is None or not ev.get("start"):
                    continue
                items.append(ev)
    _agenda_cache[username] = (time.time(), items)
    return items


def _trigger_at(ev: dict) -> datetime | None:
    try:
        if ev["all_day"]:
            start = datetime.fromisoformat(ev["start"][:10]).replace(tzinfo=_TZ)
        else:
            start = _iso_to_dt(ev["start"])
    except ValueError:
        return None
    return start - timedelta(minutes=int(ev["alarm_minutes"]))


async def _reminder_tick(username: str, since: datetime, now: datetime) -> int:
    sent = 0
    events = await _agenda_with_alarms(username)
    if not events:
        return 0
    from services.ntfy_publish import notify_users
    for ev in events:
        trig = _trigger_at(ev)
        if trig is None or not (since < trig <= now):
            continue
        key = f"{ev['uid']}|{ev.get('recurrence_id') or ev['start']}|{ev['alarm_minutes']}"
        async with user_tx(username) as conn:
            ins = await conn.execute(
                "INSERT INTO claraos_planner_reminders (username, key) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                username, key)
        if not ins.endswith("1"):
            continue
        if ev["all_day"]:
            when = datetime.fromisoformat(ev["start"][:10]).strftime("%d.%m.") + " (ganztägig)"
        else:
            s = _iso_to_dt(ev["start"]).astimezone(_TZ)
            when = s.strftime("%d.%m. %H:%M") if s.date() != now.astimezone(_TZ).date() else f"heute {s.strftime('%H:%M')}"
        msg = when + (f" · {ev['location']}" if ev.get("location") else "")
        try:
            sent += await notify_users([username], f"🗓 {ev['summary'] or 'Termin'}", msg, app_id="planner")
        except Exception as exc:  # noqa: BLE001
            logger.warning("[planner-reminder] %s: %s", username, exc)
    return sent


async def reminder_loop() -> None:
    """Background task: users' VALARM reminders as ntfy push. Started from main.py.
    Starts 3 min in the past so a restart (deploy) does not swallow a
    reminder; the table prevents duplicate pushes."""
    last = datetime.now(timezone.utc) - timedelta(minutes=3)
    while True:
        await asyncio.sleep(60)
        now = datetime.now(timezone.utc)
        try:
            await _ensure_reminder_table()
            for p in await _people():
                try:
                    if not await _push_enabled(p["username"]):
                        continue
                    n = await _reminder_tick(p["username"], last, now)
                    if n:
                        logger.info("[planner-reminder] %s: %d Push", p["username"], n)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("[planner-reminder] %s: %s", p["username"], exc)
            if now.minute == 3:
                # Housekeeping across all users — plain pool on purpose.
                pool = await get_pool()
                async with pool.acquire() as conn:
                    await conn.execute("DELETE FROM claraos_planner_reminders WHERE sent_at < NOW() - INTERVAL '3 days'")
        except Exception as exc:  # noqa: BLE001
            logger.warning("[planner-reminder] Lauf fehlgeschlagen: %s", exc)
        last = now


def invalidate_agenda(username: str) -> None:
    """After event changes: discard the user's reminder cache."""
    _agenda_cache.pop(username, None)
