"""Per-user Nextcloud PIM (tasks / calendar / contacts / deck).

Per-user identity for the assistant. Mirrors the per-user pattern of
`files.py`: every call runs as the *authenticated caller's* Nextcloud account
(creds from `claraos_app_credentials`, app_id='nextcloud'), so user A only ever
sees A's tasks/events/contacts/boards.

Reached via the `claraos_modules` bridge (clara_tools.call_tool), which forwards
the trusted chat-user as `X-Claraos-User` (set by clara-agent, never the LLM).
These routes therefore resolve the caller from `X-Claraos-User` first, then
`X-Authentik-Username` (reverse-proxy forward-auth, for direct browser use). They are
NOT meant to be LLM-arg-driven — there is no `username` body field on purpose.

CalDAV/CardDAV are hand-rolled with raw httpx (PROPFIND / REPORT / PUT) and a
tolerant line-based iCal/vCard parser — no extra dependency, consistent with
files.py's hand-rolled WebDAV.
"""
from __future__ import annotations

import logging
import re
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from urllib.parse import quote as urlquote

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from routers.files import NEXTCLOUD_INTERNAL_URL, _auth_header, _nc_credentials
from auth import require_caller
from betriebsprofil import heim_default
from services import localtime

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/nc", tags=["nc-pim"])

# XML namespaces
_DAV = "DAV:"
_CALDAV = "urn:ietf:params:xml:ns:caldav"
_CARDDAV = "urn:ietf:params:xml:ns:carddav"

_TIMEOUT = 20.0


# ── caller / credentials ────────────────────────────────────────────────────

def _caller(request: Request) -> str:
    """The authenticated user on whose behalf this call runs.

    Security: delegates to `auth.require_caller`, which FIRST checks the trust
    anchor (a machine's service token or the reverse proxy's secret) and only
    then returns the identity. Reading the header alone would let any device on
    the local network, and any logged-in user, impersonate any other user.
    """
    return require_caller(request)


async def _creds(request: Request) -> tuple[str, str]:
    return await _nc_credentials(_caller(request))


def _caldav_home(nc_user: str) -> str:
    return f"{NEXTCLOUD_INTERNAL_URL}/remote.php/dav/calendars/{urlquote(nc_user, safe='')}/"


def _carddav_home(nc_user: str) -> str:
    return f"{NEXTCLOUD_INTERNAL_URL}/remote.php/dav/addressbooks/users/{urlquote(nc_user, safe='')}/"


def _deck_base() -> str:
    return f"{NEXTCLOUD_INTERNAL_URL}/index.php/apps/deck/api/v1.0"


async def _dav(method: str, url: str, nc_user: str, nc_pass: str,
               body: str | None = None, depth: str = "1",
               content_type: str = "application/xml; charset=utf-8",
               if_match: str | None = None, if_none_match: bool = False) -> httpx.Response:
    """A single DAV request.

    Important: `if_match` / `if_none_match` protect against lost updates:
    - `if_match=<etag>`: write only if the item on the server is still exactly
      the one we just read. Otherwise Nextcloud answers 412.
    - `if_none_match=True`: create only if nothing exists at that URL yet.
    Without these headers a PUT overwrites unconditionally: a concurrent edit
    made on a phone would disappear silently.
    """
    headers = _auth_header(nc_user, nc_pass)
    headers["Depth"] = depth
    if body is not None:
        headers["Content-Type"] = content_type
    if if_match:
        headers["If-Match"] = if_match
    if if_none_match:
        headers["If-None-Match"] = "*"
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        return await client.request(method, url, headers=headers, content=body.encode() if body else None)


_PROPFIND_ETAG = (
    '<?xml version="1.0" encoding="utf-8" ?>'
    '<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>'
)


async def _etag_of(url: str, nc_user: str, nc_pass: str) -> str | None:
    """Fetch the ETag of a single item.

    For code paths that build the URL themselves (`{uid}.ics`) instead of
    getting it from a REPORT; they would otherwise have no ETag and have to
    write unconditionally. `None` means: nothing here (404). An empty string
    means: the item exists, but the server reports no ETag.
    """
    resp = await _dav("PROPFIND", url, nc_user, nc_pass, _PROPFIND_ETAG, depth="0")
    if resp.status_code not in (207, 200):
        return None
    try:
        root = ET.fromstring(resp.content)
    except ET.ParseError:
        return None
    el = root.find(f".//{{{_DAV}}}getetag")
    return (el.text or "").strip() if el is not None else ""


def _guard_conflict(resp: httpx.Response, was: str) -> None:
    """412 is not a server error but a statement: the item changed between our
    read and our write. The caller should get a 409 so the UI can reload and
    offer the edit again. A 502 would present it as an outage and invite a
    retry, which would permanently destroy the other change.
    """
    if resp.status_code == 412:
        # Important: the key message is "not saved". Without it, users read
        # "was changed" and assume their edit went through anyway, so their
        # change is silently lost, just with a message instead of without.
        raise HTTPException(
            status_code=409,
            detail=(f"{was} wurde zwischenzeitlich an anderer Stelle geändert "
                    "(z. B. am Handy). Deine Änderung wurde NICHT gespeichert — "
                    "bitte den aktuellen Stand ansehen und erneut speichern."),
        )


# ── collection discovery ────────────────────────────────────────────────────

_PROPFIND_CAL = (
    '<?xml version="1.0" encoding="utf-8" ?>'
    '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"'
    ' xmlns:ical="http://apple.com/ns/ical/">'
    '<d:prop><d:resourcetype/><d:displayname/>'
    '<d:current-user-privilege-set/>'
    '<ical:calendar-color/>'
    '<c:supported-calendar-component-set/></d:prop></d:propfind>'
)
_ICAL_NS = "http://apple.com/ns/ical/"
_PROPFIND_AB = (
    '<?xml version="1.0" encoding="utf-8" ?>'
    '<d:propfind xmlns:d="DAV:"><d:prop>'
    '<d:resourcetype/><d:displayname/></d:prop></d:propfind>'
)


async def _calendars(nc_user: str, nc_pass: str, component: str) -> list[dict]:
    """Return [{url, name}] of the user's calendars supporting `component`
    (VEVENT or VTODO)."""
    resp = await _dav("PROPFIND", _caldav_home(nc_user), nc_user, nc_pass, _PROPFIND_CAL)
    if resp.status_code not in (207, 200):
        logger.warning("calendar PROPFIND %s → %s", nc_user, resp.status_code)
        return []
    out: list[dict] = []
    root = ET.fromstring(resp.content)
    for r in root.findall(f"{{{_DAV}}}response"):
        rt = r.find(f".//{{{_DAV}}}resourcetype")
        if rt is None or rt.find(f"{{{_CALDAV}}}calendar") is None:
            continue
        comps = {c.get("name") for c in r.findall(f".//{{{_CALDAV}}}comp")}
        # NC reports the component set only on real calendars; default-allow if absent.
        if comps and component not in comps:
            continue
        href_el = r.find(f"{{{_DAV}}}href")
        if href_el is None or not href_el.text:
            continue
        name_el = r.find(f".//{{{_DAV}}}displayname")
        # App-generated calendars (Deck boards, contact birthdays) sync read-only
        # VTODO/VEVENT into CalDAV — a PUT there 403s. Flag writability so the
        # default add-target skips them.
        privs = {p.tag for p in r.iter() if p.tag.startswith(f"{{{_DAV}}}")
                 and p.tag.split('}')[1] in ("write", "write-content", "all", "bind")}
        color_el = r.find(f".//{{{_ICAL_NS}}}calendar-color")
        # NC returns #RRGGBBAA; strip alpha for the frontend
        color = (color_el.text or "").strip() if color_el is not None else ""
        if len(color) == 9 and color.startswith("#"):
            color = color[:7]
        out.append({
            "url": NEXTCLOUD_INTERNAL_URL + href_el.text,
            "name": (name_el.text if name_el is not None else "") or "",
            "writable": bool(privs),
            "color": color,
        })
    return out


def _default_target(cals: list[dict], wanted_name: str | None) -> dict:
    """Pick the calendar to create an item in: a name match if given, else the
    first *writable* calendar (skips read-only Deck/birthday calendars), else
    the first one as a last resort."""
    if wanted_name:
        m = next((c for c in cals if c["name"].lower() == wanted_name.lower()), None)
        if m:
            return m
    return next((c for c in cals if c.get("writable")), cals[0])


# Many NC users have no writable VTODO list — only the read-only Deck-synced
# ones (the personal calendar is often VEVENT-only). Mirror the NC Tasks app:
# create a dedicated VTODO calendar on first write.
_MKCALENDAR_VTODO = (
    '<?xml version="1.0" encoding="utf-8" ?>'
    '<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
    '<d:set><d:prop>'
    '<d:displayname>Aufgaben</d:displayname>'
    '<c:supported-calendar-component-set><c:comp name="VTODO"/>'
    '</c:supported-calendar-component-set>'
    '</d:prop></d:set></c:mkcalendar>'
)


async def _writable_task_calendar(nc_user: str, nc_pass: str,
                                  wanted_name: str | None) -> dict:
    """Return a writable VTODO calendar for the user, creating one if none
    exists. Prefers a name match, then any existing writable list."""
    cals = await _calendars(nc_user, nc_pass, "VTODO")
    if wanted_name:
        m = next((c for c in cals if c.get("writable")
                  and c["name"].lower() == wanted_name.lower()), None)
        if m:
            return m
    w = next((c for c in cals if c.get("writable")), None)
    if w:
        return w
    # none writable → create a dedicated task list
    url = _caldav_home(nc_user).rstrip("/") + "/claraos-tasks/"
    resp = await _dav("MKCALENDAR", url, nc_user, nc_pass, _MKCALENDAR_VTODO)
    if resp.status_code in (201,):
        return {"url": url, "name": "Aufgaben", "writable": True}
    # 405/409 = already exists, or a race — re-resolve
    cals = await _calendars(nc_user, nc_pass, "VTODO")
    w = next((c for c in cals if c.get("writable")), None)
    if w:
        return w
    raise HTTPException(status_code=502,
                        detail=f"No writable task list and MKCALENDAR failed ({resp.status_code})")


async def _addressbooks(nc_user: str, nc_pass: str) -> list[dict]:
    resp = await _dav("PROPFIND", _carddav_home(nc_user), nc_user, nc_pass, _PROPFIND_AB)
    if resp.status_code not in (207, 200):
        logger.warning("addressbook PROPFIND %s → %s", nc_user, resp.status_code)
        return []
    out: list[dict] = []
    root = ET.fromstring(resp.content)
    for r in root.findall(f"{{{_DAV}}}response"):
        rt = r.find(f".//{{{_DAV}}}resourcetype")
        if rt is None or rt.find(f"{{{_CARDDAV}}}addressbook") is None:
            continue
        href_el = r.find(f"{{{_DAV}}}href")
        if href_el is None or not href_el.text:
            continue
        name_el = r.find(f".//{{{_DAV}}}displayname")
        out.append({
            "url": NEXTCLOUD_INTERNAL_URL + href_el.text,
            "name": (name_el.text if name_el is not None else "") or "",
        })
    return out


# ── iCal / vCard parsing (tolerant, line-based) ─────────────────────────────

def _unfold(text: str) -> list[str]:
    """RFC-5545 line unfolding: continuation lines start with space/tab."""
    out: list[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and out:
            out[-1] += raw[1:]
        else:
            out.append(raw)
    return out


def _blocks(text: str, name: str) -> list[list[tuple[str, str, str]]]:
    """Split unfolded text into BEGIN:<name>..END:<name> blocks.

    Each block is a list of (key, params, value) tuples (key uppercased)."""
    blocks: list[list[tuple[str, str, str]]] = []
    cur: list[tuple[str, str, str]] | None = None
    for line in _unfold(text):
        if line == f"BEGIN:{name}":
            cur = []
            continue
        if line == f"END:{name}":
            if cur is not None:
                blocks.append(cur)
            cur = None
            continue
        if cur is None or ":" not in line:
            continue
        head, _, value = line.partition(":")
        key, _, params = head.partition(";")
        cur.append((key.strip().upper(), params, value))
    return blocks


def _first(block: list[tuple[str, str, str]], key: str) -> str:
    for k, _p, v in block:
        if k == key:
            return v
    return ""


def _all(block: list[tuple[str, str, str]], key: str) -> list[str]:
    return [v for k, _p, v in block if k == key and v]


def _first_p(block: list[tuple[str, str, str]], key: str) -> tuple[str, str]:
    """Like _first, but returns (value, params) so TZID is not lost."""
    for k, p, v in block:
        if k == key:
            return v, p
    return "", ""


def _fmt_local(block: list[tuple[str, str, str]], key: str) -> tuple[str, str]:
    """(ISO in local time with offset, readable label) for a DATE/DATE-TIME property.

    Honours TZID and reads floating times as local time, so the value the
    assistant reads back is exactly the wall-clock time the user meant.
    """
    value, params = _first_p(block, key)
    parsed = localtime.from_ical(value, params)
    if parsed is None:
        return value, ""
    return localtime.iso_local(parsed), localtime.label(parsed)


def _fmt_dt(value: str) -> str:
    """Normalize an iCal DATE/DATE-TIME value to ISO-ish for display."""
    v = value.strip()
    if not v:
        return ""
    # 20260616T140000Z / 20260616T140000 / 20260616
    try:
        if v.endswith("Z"):
            dt = datetime.strptime(v, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
            return dt.isoformat()
        if "T" in v:
            return datetime.strptime(v, "%Y%m%dT%H%M%S").isoformat()
        if len(v) == 8:
            return datetime.strptime(v, "%Y%m%d").date().isoformat()
    except ValueError:
        pass
    return v


# ── update/delete helpers (uid → href resolution + raw-iCal patching) ────────

def _hrefs_and_data(resp: httpx.Response) -> list[tuple[str, str, str]]:
    """From a calendar/addressbook REPORT, return [(href, item-text, etag)].

    The href is the item's server path — needed for update/delete, because a NC
    item's filename is NOT generally `{uid}.ics` (only our own creations are).
    The `etag` is the version we read; it is passed as `If-Match` to the
    subsequent write (see `_dav`).
    """
    if resp.status_code not in (207, 200):
        return []
    out: list[tuple[str, str, str]] = []
    root = ET.fromstring(resp.content)
    for r in root.findall(f"{{{_DAV}}}response"):
        href_el = r.find(f"{{{_DAV}}}href")
        if href_el is None or not href_el.text:
            continue
        etag_el = r.find(f".//{{{_DAV}}}getetag")
        etag = (etag_el.text or "").strip() if etag_el is not None else ""
        data = None
        for tag in (f"{{{_CALDAV}}}calendar-data", f"{{{_CARDDAV}}}address-data"):
            el = r.find(f".//{tag}")
            if el is not None and el.text:
                data = el.text
                break
        if data is not None:
            out.append((NEXTCLOUD_INTERNAL_URL + href_el.text, data, etag))
    return out


async def _resolve_item(nc_user: str, nc_pass: str, collections: list[dict],
                        report_body: str, block_name: str, uid: str) -> tuple[str, str, str]:
    """Find the item with the given UID across `collections`.

    Returns (item_url, raw_text, etag). Raises 404 if no item matches.
    `block_name` is VTODO / VEVENT / VCARD; `report_body` is the matching REPORT.

    Important: the `etag` belongs to THIS read. Passing it on means the write
    only happens if nothing changed since. If it is empty (the server sent
    none), we write unconditionally; that unsafe path is a fallback only, not
    the normal case.
    """
    for col in collections:
        resp = await _dav("REPORT", col["url"], nc_user, nc_pass, report_body)
        for href, text, etag in _hrefs_and_data(resp):
            for blk in _blocks(text, block_name):
                if _first(blk, "UID") == uid:
                    return href, text, etag
    raise HTTPException(status_code=404, detail=f"{block_name} with uid {uid!r} not found")


def _patch_ical(raw: str, block_name: str, sets: dict[str, str],
                removes: set[str] | None = None) -> str:
    """Patch single-valued properties inside the first BEGIN/END:<block_name>.

    `sets` maps full property lines (e.g. {"STATUS": "STATUS:COMPLETED"}) keyed by
    the bare property name. Existing lines with that key are replaced in place;
    missing keys are appended just before END:<block_name>. Keys in `removes` are
    dropped. Everything else (alarms, recurrence, categories, …) is preserved.
    Callers should include an updated DTSTAMP/LAST-MODIFIED in `sets` so clients
    re-sync.
    """
    removes = removes or set()
    lines = _unfold(raw)
    out: list[str] = []
    in_block = False
    seen: set[str] = set()
    depth = 0  # nested VALARM etc. — only patch the top level of our block
    for line in lines:
        key = line.split(":", 1)[0].split(";", 1)[0].strip().upper()
        if line == f"BEGIN:{block_name}":
            in_block, depth = True, 0
            out.append(line)
            continue
        if in_block and line.startswith("BEGIN:"):
            depth += 1
            out.append(line)
            continue
        if in_block and line.startswith("END:") and depth > 0:
            depth -= 1
            out.append(line)
            continue
        if in_block and depth == 0 and line == f"END:{block_name}":
            # append any sets/markers that weren't already present
            for k, v in sets.items():
                if k not in seen:
                    out.append(v)
            out.append(line)
            in_block = False
            continue
        if in_block and depth == 0:
            if key in removes:
                continue
            if key in sets:
                out.append(sets[key])
                seen.add(key)
                continue
        out.append(line)
    return "\r\n".join(l for l in out if l != "")


def _now_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


# ── TASKS (VTODO) ───────────────────────────────────────────────────────────

_REPORT_TODO = (
    '<?xml version="1.0" encoding="utf-8" ?>'
    '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
    '<d:prop><d:getetag/><c:calendar-data/></d:prop>'
    '<c:filter><c:comp-filter name="VCALENDAR">'
    '<c:comp-filter name="VTODO"/></c:comp-filter></c:filter></c:calendar-query>'
)


def _calendar_data_texts(resp: httpx.Response) -> list[str]:
    if resp.status_code not in (207, 200):
        return []
    root = ET.fromstring(resp.content)
    out = []
    for cd in root.iter(f"{{{_CALDAV}}}calendar-data"):
        if cd.text:
            out.append(cd.text)
    return out


class TasksList(BaseModel):
    include_completed: bool = False
    lists: list[str] | None = None   # display-name filter; None = all


@router.post("/tasks/list")
async def tasks_list(request: Request, body: TasksList) -> dict:
    nc_user, nc_pass = await _creds(request)
    cals = await _calendars(nc_user, nc_pass, "VTODO")
    if body.lists:
        wanted = set(body.lists)
        cals = [c for c in cals if c["name"] in wanted]
    tasks: list[dict] = []
    for cal in cals:
        resp = await _dav("REPORT", cal["url"], nc_user, nc_pass, _REPORT_TODO)
        for ics in _calendar_data_texts(resp):
            for blk in _blocks(ics, "VTODO"):
                status = _first(blk, "STATUS").upper()
                completed = status == "COMPLETED" or bool(_first(blk, "COMPLETED"))
                if completed and not body.include_completed:
                    continue
                due_iso, due_label = _fmt_local(blk, "DUE")
                tasks.append({
                    "summary": _first(blk, "SUMMARY"),
                    "status": status or ("COMPLETED" if completed else "NEEDS-ACTION"),
                    "due": due_iso,
                    "due_lokal": due_label,
                    "priority": _first(blk, "PRIORITY"),
                    "completed": completed,
                    "uid": _first(blk, "UID"),
                    "calendar": cal["name"],
                })
    tasks.sort(key=lambda t: (t["completed"], t["due"] or "9999"))
    return {"resolved_user": _caller(request), "count": len(tasks), "tasks": tasks}


class TaskAdd(BaseModel):
    summary: str
    due: str | None = None       # ISO date or datetime
    calendar: str | None = None  # display name; default = first VTODO calendar
    priority: int | None = None  # iCal PRIORITY 1 (high) .. 9 (low)


_TIME_HINT = ("Use local time in the format YYYY-MM-DDTHH:MM (e.g. 2026-10-06T15:00), "
              f"without 'Z' — it is read as {localtime.LOCAL_TZ_NAME}; a date alone "
              "(YYYY-MM-DD) means all day.")


def _ical_dt(value: str) -> str:
    """ISO → iCal DATE (date only) or DATE-TIME in UTC.

    A time WITHOUT a zone is local wall-clock time (see services/localtime.py);
    it used to be read as UTC, which put every appointment two hours late.
    """
    try:
        parsed = localtime.parse_iso(value)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"Time {value!r} not understood. {_TIME_HINT}")
    if isinstance(parsed, datetime):
        return parsed.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return parsed.strftime("%Y%m%d")


@router.post("/tasks/lists")
async def task_lists(request: Request) -> dict:
    """Available task lists (VTODO calendars), for the list picker."""
    nc_user, nc_pass = await _creds(request)
    cals = await _calendars(nc_user, nc_pass, "VTODO")
    return {
        "lists": [
            {"name": c["name"], "color": c.get("color", ""), "writable": c["writable"]}
            for c in cals
        ]
    }


@router.post("/tasks/add")
async def task_add(request: Request, body: TaskAdd) -> dict:
    nc_user, nc_pass = await _creds(request)
    target = await _writable_task_calendar(nc_user, nc_pass, body.calendar)
    uid = str(uuid.uuid4())
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ClaraOS//nc_pim//EN",
             "BEGIN:VTODO", f"UID:{uid}", f"DTSTAMP:{stamp}",
             f"SUMMARY:{body.summary}", "STATUS:NEEDS-ACTION"]
    if body.due:
        d = _ical_dt(body.due)
        lines.append(f"DUE:{d}" if "T" in d else f"DUE;VALUE=DATE:{d}")
    if body.priority is not None and 1 <= body.priority <= 9:
        lines.append(f"PRIORITY:{body.priority}")
    lines += ["END:VTODO", "END:VCALENDAR"]
    url = target["url"].rstrip("/") + f"/{uid}.ics"
    # if_none_match: create means create; never overwrite an existing item that
    # happens to live at this URL already.
    resp = await _dav("PUT", url, nc_user, nc_pass, "\r\n".join(lines),
                      content_type="text/calendar; charset=utf-8", if_none_match=True)
    _guard_conflict(resp, "Die Aufgabe")
    if resp.status_code not in (201, 204):
        raise HTTPException(status_code=502, detail=f"Nextcloud PUT failed: {resp.status_code} {resp.text[:200]}")
    return {"ok": True, "uid": uid, "calendar": target["name"]}


async def _put_ical(url: str, nc_user: str, nc_pass: str, ical: str,
                    etag: str = "", was: str = "Der Eintrag", neu: bool = False) -> None:
    """`etag` = update (If-Match), `neu=True` = create (If-None-Match).
    Both at once is a logic error and is rejected."""
    if neu and etag:
        raise ValueError("_put_ical: entweder anlegen (neu) oder ändern (etag), nicht beides")
    resp = await _dav("PUT", url, nc_user, nc_pass, ical,
                      content_type="text/calendar; charset=utf-8",
                      if_match=etag or None, if_none_match=neu)
    _guard_conflict(resp, was)
    if resp.status_code not in (201, 204):
        raise HTTPException(status_code=502, detail=f"Nextcloud PUT failed: {resp.status_code} {resp.text[:200]}")


class TaskComplete(BaseModel):
    uid: str
    completed: bool = True   # set False to re-open a task


@router.post("/tasks/complete")
async def task_complete(request: Request, body: TaskComplete) -> dict:
    """Mark a to-do done (or re-open it). The everyday 'check it off' action."""
    nc_user, nc_pass = await _creds(request)
    cals = await _calendars(nc_user, nc_pass, "VTODO")
    url, raw, etag = await _resolve_item(nc_user, nc_pass, cals, _REPORT_TODO, "VTODO", body.uid)
    stamp = _now_stamp()
    if body.completed:
        sets = {"STATUS": "STATUS:COMPLETED", "PERCENT-COMPLETE": "PERCENT-COMPLETE:100",
                "COMPLETED": f"COMPLETED:{stamp}", "DTSTAMP": f"DTSTAMP:{stamp}",
                "LAST-MODIFIED": f"LAST-MODIFIED:{stamp}"}
        removes: set[str] = set()
    else:
        sets = {"STATUS": "STATUS:NEEDS-ACTION", "DTSTAMP": f"DTSTAMP:{stamp}",
                "LAST-MODIFIED": f"LAST-MODIFIED:{stamp}"}
        removes = {"COMPLETED", "PERCENT-COMPLETE"}
    await _put_ical(url, nc_user, nc_pass, _patch_ical(raw, "VTODO", sets, removes),
                    etag, "Die Aufgabe")
    return {"ok": True, "uid": body.uid, "completed": body.completed}


class TaskUpdate(BaseModel):
    uid: str
    summary: str | None = None
    due: str | None = None        # ISO date/datetime; "" clears the due date
    priority: int | None = None   # 1 (high) .. 9 (low), 0 = none


@router.post("/tasks/update")
async def task_update(request: Request, body: TaskUpdate) -> dict:
    nc_user, nc_pass = await _creds(request)
    cals = await _calendars(nc_user, nc_pass, "VTODO")
    url, raw, etag = await _resolve_item(nc_user, nc_pass, cals, _REPORT_TODO, "VTODO", body.uid)
    stamp = _now_stamp()
    sets = {"DTSTAMP": f"DTSTAMP:{stamp}", "LAST-MODIFIED": f"LAST-MODIFIED:{stamp}"}
    removes: set[str] = set()
    if body.summary is not None:
        sets["SUMMARY"] = f"SUMMARY:{body.summary}"
    if body.due is not None:
        if body.due == "":
            removes.add("DUE")
        else:
            d = _ical_dt(body.due)
            sets["DUE"] = f"DUE:{d}" if "T" in d else f"DUE;VALUE=DATE:{d}"
    if body.priority is not None:
        if body.priority == 0:
            removes.add("PRIORITY")
        else:
            sets["PRIORITY"] = f"PRIORITY:{max(1, min(9, body.priority))}"
    await _put_ical(url, nc_user, nc_pass, _patch_ical(raw, "VTODO", sets, removes),
                    etag, "Die Aufgabe")
    return {"ok": True, "uid": body.uid}


class TaskDelete(BaseModel):
    uid: str


@router.post("/tasks/delete")
async def task_delete(request: Request, body: TaskDelete) -> dict:
    """Delete a to-do. Reversible: it lands in Nextcloud's calendar trash (30 days)."""
    nc_user, nc_pass = await _creds(request)
    cals = await _calendars(nc_user, nc_pass, "VTODO")
    url, _raw, etag = await _resolve_item(nc_user, nc_pass, cals, _REPORT_TODO, "VTODO", body.uid)
    resp = await _dav("DELETE", url, nc_user, nc_pass, if_match=etag or None)
    _guard_conflict(resp, "Die Aufgabe")
    if resp.status_code not in (200, 204):
        raise HTTPException(status_code=502, detail=f"Nextcloud DELETE failed: {resp.status_code} {resp.text[:200]}")
    return {"ok": True, "uid": body.uid, "trashed": True}


# ── CALENDAR (VEVENT) ───────────────────────────────────────────────────────

def _report_events(start: str, end: str) -> str:
    return (
        '<?xml version="1.0" encoding="utf-8" ?>'
        '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
        '<d:prop><c:calendar-data/></d:prop>'
        '<c:filter><c:comp-filter name="VCALENDAR">'
        f'<c:comp-filter name="VEVENT"><c:time-range start="{start}" end="{end}"/>'
        '</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>'
    )


class EventsList(BaseModel):
    days: int = 7
    days_past: int = 0                  # look-back (mini month view)
    calendars: list[str] | None = None  # display-name filter; None = all
    # Explicit window (local time or ISO with offset). Overrides days/days_past.
    # `from` is a Python keyword, hence the alias.
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None
    query: str | None = None            # filter: summary/location contains

    model_config = {"populate_by_name": True}


@router.post("/calendar/calendars")
async def calendar_calendars(request: Request) -> dict:
    """The user's available calendars (name, color, writable), for the
    calendar picker in the widget and the target-calendar dropdown."""
    nc_user, nc_pass = await _creds(request)
    cals = await _calendars(nc_user, nc_pass, "VEVENT")
    return {
        "calendars": [
            {"name": c["name"], "color": c.get("color", ""), "writable": c["writable"]}
            for c in cals
        ]
    }


def _event_row(blk: list[tuple[str, str, str]], cal: dict) -> dict:
    start_iso, start_label = _fmt_local(blk, "DTSTART")
    end_iso, end_label = _fmt_local(blk, "DTEND")
    return {
        "summary": _first(blk, "SUMMARY"),
        "start": start_iso,
        "end": end_iso,
        "start_lokal": start_label,
        "end_lokal": end_label,
        "location": _first(blk, "LOCATION"),
        "uid": _first(blk, "UID"),
        "calendar": cal["name"],
        "color": cal.get("color", ""),
        "reminders_min": _alarm_minutes(blk_raw=blk),
    }


def _alarm_minutes(blk_raw: list[tuple[str, str, str]]) -> list[int]:
    """Minutes-before-start of the VALARMs in a parsed VEVENT block (TRIGGER:-PT15M ...)."""
    out: list[int] = []
    for k, _p, v in blk_raw:
        if k != "TRIGGER":
            continue
        m = _TRIGGER_RE.fullmatch(v.strip())
        if not m:
            continue
        days, hours, mins = (int(m.group(i) or 0) for i in (1, 2, 3))
        out.append(days * 1440 + hours * 60 + mins)
    return out


_TRIGGER_RE = re.compile(r"-P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?")


def _window(body: EventsList) -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=max(0, min(body.days_past, 366)))
    end = now + timedelta(days=max(1, min(body.days, 366)))
    if body.from_:
        start = localtime.to_utc(_check_iso(body.from_))
    if body.to:
        end = localtime.to_utc(_check_iso(body.to))
        if body.to.strip() and "T" not in body.to.strip():
            end += timedelta(days=1)   # "to" as a date includes that whole day
    if end <= start:
        raise HTTPException(status_code=422, detail="'to' must be after 'from'. " + _TIME_HINT)
    return start, end


def _check_iso(value: str) -> str:
    try:
        localtime.parse_iso(value)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"Time {value!r} not understood. {_TIME_HINT}")
    return value


@router.post("/calendar/list")
async def calendar_list(request: Request, body: EventsList) -> dict:
    nc_user, nc_pass = await _creds(request)
    w_start, w_end = _window(body)
    rep = _report_events(w_start.strftime("%Y%m%dT%H%M%SZ"), w_end.strftime("%Y%m%dT%H%M%SZ"))
    cals = await _calendars(nc_user, nc_pass, "VEVENT")
    unknown: list[str] = []
    if body.calendars:
        wanted = {c.lower() for c in body.calendars}
        unknown = sorted(wanted - {c["name"].lower() for c in cals})
        cals = [c for c in cals if c["name"].lower() in wanted]
    q = (body.query or "").strip().lower()
    events: list[dict] = []
    for cal in cals:
        resp = await _dav("REPORT", cal["url"], nc_user, nc_pass, rep)
        for ics in _calendar_data_texts(resp):
            for blk in _blocks(ics, "VEVENT"):
                row = _event_row(blk, cal)
                if q and q not in f"{row['summary']} {row['location']}".lower():
                    continue
                events.append(row)
    events.sort(key=lambda e: localtime.to_utc(e["start"]).isoformat() if e["start"] else "9999")
    return {"resolved_user": _caller(request), "count": len(events),
            "window": {"from": localtime.label(w_start), "to": localtime.label(w_end),
                       "timezone": localtime.LOCAL_TZ_NAME},
            "events": events,
            **({"unknown_calendars": unknown,
                "hint": f"These calendars do not exist: {unknown}. "
                        f"Available: {[c['name'] for c in await _calendars(nc_user, nc_pass, 'VEVENT')]}"}
               if unknown else {})}


class EventAdd(BaseModel):
    summary: str
    start: str            # local time (YYYY-MM-DDTHH:MM) or ISO with offset; date = all day
    end: str | None = None
    location: str | None = None
    calendar: str | None = None
    description: str | None = None
    erinnerung_minuten: int | None = None   # VALARM this many minutes before start


def _public_link(app: str, **params: str) -> str:
    base = (heim_default("CLARAOS_PUBLIC_URL") or "").rstrip("/")
    extra = "".join(f"&{k}={urlquote(str(v), safe='')}" for k, v in params.items() if v)
    return f"{base}/?app={app}{extra}"


def _ical_text(value: str) -> str:
    """Escape a TEXT value (RFC 5545 3.3.11) and keep it on one logical line."""
    return (value.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
            .replace("\r\n", "\\n").replace("\n", "\\n"))


def _ical_unescape(value: str) -> str:
    return (value.replace("\\n", "\n").replace("\\N", "\n").replace("\\,", ",")
            .replace("\\;", ";").replace("\\\\", "\\"))


async def _read_back(url: str, nc_user: str, nc_pass: str,
                     block_name: str, uid: str) -> list[tuple[str, str, str]] | None:
    """Re-read an item right after writing it — the evidence behind `verified`."""
    resp = await _dav("GET", url, nc_user, nc_pass, depth="0")
    if resp.status_code != 200:
        return None
    for blk in _blocks(resp.text, block_name):
        if _first(blk, "UID") == uid:
            return blk
    return None


def _same_instant(a: str, b: str) -> bool:
    """Do two iCal DATE/DATE-TIME values (as written) denote the same moment?"""
    return localtime.from_ical(a) == localtime.from_ical(b)


def _event_result(blk: list[tuple[str, str, str]] | None, uid: str, cal_name: str,
                  want: dict[str, str], action: str) -> dict:
    """Uniform write result: ok + id + link + verified + readable fields.

    `want` maps iCal keys (SUMMARY, DTSTART, DTEND) to the values we wrote; the
    read-back must match them, otherwise the write is reported as NOT verified.
    """
    link = _public_link("planner", view="calendar")
    if blk is None:
        return {"ok": False, "id": uid, "uid": uid, "verified": False, "link": link,
                "error": f"The event was written but could not be read back ({action}).",
                "hint": "Call list_events for that day and check whether the event is there "
                        "before telling the user it worked."}
    mismatch = []
    for key, val in want.items():
        got = _first(blk, key)
        same = _same_instant(got, val) if key.startswith("DT") else _ical_unescape(got) == val
        if not same:
            mismatch.append(f"{key}: wrote {val!r}, read {got!r}")
    row = _event_row(blk, {"name": cal_name})
    row.pop("color", None)
    out = {"ok": not mismatch, "id": uid, "verified": not mismatch, "link": link, **row}
    if mismatch:
        out.update({"error": "Read-back differs from what was written: " + "; ".join(mismatch),
                    "hint": "Do not report success. Tell the user what is stored and fix it "
                            "with update_event."})
    return out


@router.post("/calendar/add")
async def calendar_add(request: Request, body: EventAdd) -> dict:
    nc_user, nc_pass = await _creds(request)
    cals = await _calendars(nc_user, nc_pass, "VEVENT")
    if not cals:
        raise HTTPException(status_code=404, detail="No calendar (VEVENT) found in Nextcloud")
    if body.calendar and not any(c["name"].lower() == body.calendar.lower() for c in cals):
        # No silent fallback to another calendar: the user named this one.
        raise HTTPException(
            status_code=404,
            detail=(f"Calendar {body.calendar!r} does not exist. Writable calendars: "
                    f"{[c['name'] for c in cals if c.get('writable')]}. Ask the user which one "
                    "to use instead of picking one yourself."))
    target = _default_target(cals, body.calendar)
    uid = str(uuid.uuid4())
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dtstart = _ical_dt(body.start)
    dtend = _ical_dt(body.end) if body.end else None
    if dtend and "T" in dtstart and "T" in dtend and dtend <= dtstart:
        raise HTTPException(status_code=422, detail="'end' must be after 'start'. " + _TIME_HINT)
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ClaraOS//nc_pim//EN",
             "BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{stamp}",
             f"DTSTART:{dtstart}" if "T" in dtstart else f"DTSTART;VALUE=DATE:{dtstart}",
             f"SUMMARY:{_ical_text(body.summary)}"]
    if dtend:
        lines.append(f"DTEND:{dtend}" if "T" in dtend else f"DTEND;VALUE=DATE:{dtend}")
    if body.location:
        lines.append(f"LOCATION:{_ical_text(body.location)}")
    if body.description:
        lines.append(f"DESCRIPTION:{_ical_text(body.description)}")
    if body.erinnerung_minuten is not None:
        minutes = max(0, min(int(body.erinnerung_minuten), 40320))   # at most 4 weeks
        lines += ["BEGIN:VALARM", "ACTION:DISPLAY", f"DESCRIPTION:{_ical_text(body.summary)}",
                  f"TRIGGER:-PT{minutes}M", "END:VALARM"]
    lines += ["END:VEVENT", "END:VCALENDAR"]
    url = target["url"].rstrip("/") + f"/{uid}.ics"
    resp = await _dav("PUT", url, nc_user, nc_pass, "\r\n".join(lines),
                      content_type="text/calendar; charset=utf-8", if_none_match=True)
    _guard_conflict(resp, "Der Termin")
    if resp.status_code not in (201, 204):
        raise HTTPException(status_code=502, detail=f"Nextcloud PUT failed: {resp.status_code} {resp.text[:200]}")
    want = {"SUMMARY": body.summary, "DTSTART": dtstart}
    if dtend:
        want["DTEND"] = dtend
    out = _event_result(await _read_back(url, nc_user, nc_pass, "VEVENT", uid),
                        uid, target["name"], want, "add")
    if body.erinnerung_minuten is not None and out.get("ok") \
            and out.get("reminders_min") != [max(0, min(int(body.erinnerung_minuten), 40320))]:
        out.update({"ok": False, "verified": False,
                    "error": f"Reminder not stored as requested (read back: {out.get('reminders_min')}).",
                    "hint": "Tell the user the reminder is missing."})
    return out


# Resolve an event by UID across all calendars (no time-range — update/delete
# must reach events outside the list window).
_REPORT_VEVENT_ALL = (
    '<?xml version="1.0" encoding="utf-8" ?>'
    '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
    '<d:prop><d:getetag/><c:calendar-data/></d:prop>'
    '<c:filter><c:comp-filter name="VCALENDAR">'
    '<c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>'
)


class EventUpdate(BaseModel):
    uid: str
    summary: str | None = None
    start: str | None = None
    end: str | None = None        # "" clears DTEND
    location: str | None = None   # "" clears LOCATION
    erinnerung_minuten: int | None = None   # replaces existing reminders; -1 removes them


def _set_alarm(raw: str, minutes: int) -> str:
    """Replace all VALARMs of the first VEVENT by one reminder (minutes < 0: none)."""
    out: list[str] = []
    skip = False
    for line in _unfold(raw):
        if line == "BEGIN:VALARM":
            skip = True
            continue
        if skip:
            if line == "END:VALARM":
                skip = False
            continue
        if line == "END:VEVENT" and minutes >= 0:
            out += ["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Erinnerung",
                    f"TRIGGER:-PT{min(int(minutes), 40320)}M", "END:VALARM"]
            minutes = -1
        out.append(line)
    return "\r\n".join(l for l in out if l != "")


@router.post("/calendar/update")
async def calendar_update(request: Request, body: EventUpdate) -> dict:
    nc_user, nc_pass = await _creds(request)
    cals = await _calendars(nc_user, nc_pass, "VEVENT")
    url, raw, etag = await _resolve_item(nc_user, nc_pass, cals, _REPORT_VEVENT_ALL, "VEVENT", body.uid)
    stamp = _now_stamp()
    sets = {"DTSTAMP": f"DTSTAMP:{stamp}", "LAST-MODIFIED": f"LAST-MODIFIED:{stamp}"}
    removes: set[str] = set()
    if body.summary is not None:
        sets["SUMMARY"] = f"SUMMARY:{_ical_text(body.summary)}"
    if body.start is not None and body.start != "":
        d = _ical_dt(body.start)
        sets["DTSTART"] = f"DTSTART:{d}" if "T" in d else f"DTSTART;VALUE=DATE:{d}"
    if body.end is not None:
        if body.end == "":
            removes.add("DTEND")
        else:
            d = _ical_dt(body.end)
            sets["DTEND"] = f"DTEND:{d}" if "T" in d else f"DTEND;VALUE=DATE:{d}"
    if body.location is not None:
        if body.location == "":
            removes.add("LOCATION")
        else:
            sets["LOCATION"] = f"LOCATION:{body.location}"
    if body.erinnerung_minuten is not None:
        raw = _set_alarm(raw, body.erinnerung_minuten)
    await _put_ical(url, nc_user, nc_pass, _patch_ical(raw, "VEVENT", sets, removes),
                    etag, "Der Termin")
    want = {k: v.split(":", 1)[1] for k, v in sets.items() if k in ("SUMMARY", "DTSTART", "DTEND")}
    if "SUMMARY" in want:
        want["SUMMARY"] = body.summary or ""
    cal_name = next((c["name"] for c in cals if url.startswith(c["url"])), "")
    return _event_result(await _read_back(url, nc_user, nc_pass, "VEVENT", body.uid),
                         body.uid, cal_name, want, "update")


class EventDelete(BaseModel):
    uid: str


@router.post("/calendar/delete")
async def calendar_delete(request: Request, body: EventDelete) -> dict:
    """Delete an event. Reversible: lands in Nextcloud's calendar trash (30 days)."""
    nc_user, nc_pass = await _creds(request)
    cals = await _calendars(nc_user, nc_pass, "VEVENT")
    url, _raw, etag = await _resolve_item(nc_user, nc_pass, cals, _REPORT_VEVENT_ALL, "VEVENT", body.uid)
    resp = await _dav("DELETE", url, nc_user, nc_pass, if_match=etag or None)
    _guard_conflict(resp, "Der Termin")
    if resp.status_code not in (200, 204):
        raise HTTPException(status_code=502, detail=f"Nextcloud DELETE failed: {resp.status_code} {resp.text[:200]}")
    return {"ok": True, "uid": body.uid, "trashed": True}


# ── CONTACTS (VCARD) ────────────────────────────────────────────────────────

_REPORT_VCARD = (
    '<?xml version="1.0" encoding="utf-8" ?>'
    '<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">'
    '<d:prop><d:getetag/><card:address-data/></d:prop></card:addressbook-query>'
)


class ContactsList(BaseModel):
    query: str | None = None


def _vcard_value(raw: str) -> str:
    # vCard escapes commas/semicolons with backslash; structured fields use ';'
    return raw.replace("\\,", ",").replace("\\;", ";").replace("\\n", " ").strip()


@router.post("/contacts/list")
async def contacts_list(request: Request, body: ContactsList) -> dict:
    nc_user, nc_pass = await _creds(request)
    abs_ = await _addressbooks(nc_user, nc_pass)
    q = (body.query or "").lower().strip()
    contacts: list[dict] = []
    for ab in abs_:
        resp = await _dav("REPORT", ab["url"], nc_user, nc_pass, _REPORT_VCARD)
        if resp.status_code not in (207, 200):
            continue
        root = ET.fromstring(resp.content)
        for ad in root.iter(f"{{{_CARDDAV}}}address-data"):
            if not ad.text:
                continue
            for blk in _blocks(ad.text, "VCARD"):
                fn = _vcard_value(_first(blk, "FN"))
                emails = [_vcard_value(e) for e in _all(blk, "EMAIL")]
                tels = [_vcard_value(t) for t in _all(blk, "TEL")]
                org = _vcard_value(_first(blk, "ORG"))
                if q and q not in " ".join([fn, org, *emails, *tels]).lower():
                    continue
                contacts.append({
                    "name": fn, "emails": emails, "phones": tels,
                    "org": org, "uid": _first(blk, "UID"),
                })
    contacts.sort(key=lambda c: c["name"].lower())
    return {"resolved_user": _caller(request), "count": len(contacts), "contacts": contacts}


class ContactAdd(BaseModel):
    full_name: str
    email: str | None = None
    phone: str | None = None
    org: str | None = None


@router.post("/contacts/add")
async def contact_add(request: Request, body: ContactAdd) -> dict:
    nc_user, nc_pass = await _creds(request)
    abs_ = await _addressbooks(nc_user, nc_pass)
    if not abs_:
        raise HTTPException(status_code=404, detail="No address book found in Nextcloud")
    target = abs_[0]
    uid = str(uuid.uuid4())
    lines = ["BEGIN:VCARD", "VERSION:3.0", f"UID:{uid}", f"FN:{body.full_name}",
             f"N:{body.full_name};;;;"]
    if body.email:
        lines.append(f"EMAIL;TYPE=INTERNET:{body.email}")
    if body.phone:
        lines.append(f"TEL:{body.phone}")
    if body.org:
        lines.append(f"ORG:{body.org}")
    lines.append("END:VCARD")
    url = target["url"].rstrip("/") + f"/{uid}.vcf"
    resp = await _dav("PUT", url, nc_user, nc_pass, "\r\n".join(lines),
                      content_type="text/vcard; charset=utf-8", if_none_match=True)
    _guard_conflict(resp, "Der Kontakt")
    if resp.status_code not in (201, 204):
        raise HTTPException(status_code=502, detail=f"Nextcloud PUT failed: {resp.status_code} {resp.text[:200]}")
    blk = await _read_back(url, nc_user, nc_pass, "VCARD", uid)
    link = _public_link("kontakte")
    if blk is None:
        return {"ok": False, "id": uid, "uid": uid, "verified": False, "link": link,
                "addressbook": target["name"],
                "error": "The contact was written but could not be read back.",
                "hint": "Call list_contacts with the name before telling the user it worked."}
    got = {"name": _vcard_value(_first(blk, "FN")),
           "emails": [_vcard_value(e) for e in _all(blk, "EMAIL")],
           "phones": [_vcard_value(t) for t in _all(blk, "TEL")],
           "org": _vcard_value(_first(blk, "ORG"))}
    mismatch = [f for f, want, have in (("full_name", body.full_name.strip(), got["name"]),
                                        ("email", body.email, (got["emails"] or [""])[0]),
                                        ("phone", body.phone, (got["phones"] or [""])[0]),
                                        ("org", body.org, got["org"]))
                if want and want.strip() != have]
    out = {"ok": not mismatch, "id": uid, "uid": uid, "verified": not mismatch, "link": link,
           "addressbook": target["name"], **got}
    if mismatch:
        out.update({"error": f"Read-back differs in: {mismatch}",
                    "hint": "Tell the user which fields were not stored as given."})
    return out


class ContactUpdate(BaseModel):
    uid: str
    full_name: str | None = None
    email: str | None = None      # "" clears
    phone: str | None = None      # "" clears
    org: str | None = None        # "" clears


@router.post("/contacts/update")
async def contact_update(request: Request, body: ContactUpdate) -> dict:
    """Correct an existing contact. No contacts/delete by design — CardDAV has no
    trash in Nextcloud, so deletion would be irreversible; removal stays manual."""
    nc_user, nc_pass = await _creds(request)
    abs_ = await _addressbooks(nc_user, nc_pass)
    url, raw, etag = await _resolve_item(nc_user, nc_pass, abs_, _REPORT_VCARD, "VCARD", body.uid)
    sets = {"REV": f"REV:{_now_stamp()}"}
    removes: set[str] = set()
    if body.full_name is not None and body.full_name != "":
        sets["FN"] = f"FN:{body.full_name}"
        sets["N"] = f"N:{body.full_name};;;;"
    for key, val, line in (("EMAIL", body.email, "EMAIL;TYPE=INTERNET:{}"),
                           ("TEL", body.phone, "TEL:{}"),
                           ("ORG", body.org, "ORG:{}")):
        if val is None:
            continue
        if val == "":
            removes.add(key)
        else:
            sets[key] = line.format(val)
    resp = await _dav("PUT", url, nc_user, nc_pass, _patch_ical(raw, "VCARD", sets, removes),
                      content_type="text/vcard; charset=utf-8", if_match=etag or None)
    _guard_conflict(resp, "Der Kontakt")
    if resp.status_code not in (201, 204):
        raise HTTPException(status_code=502, detail=f"Nextcloud PUT failed: {resp.status_code} {resp.text[:200]}")
    return {"ok": True, "uid": body.uid}


# ── DECK (REST + OCS) ───────────────────────────────────────────────────────

async def _deck_get(path: str, nc_user: str, nc_pass: str) -> httpx.Response:
    headers = _auth_header(nc_user, nc_pass)
    headers["OCS-APIRequest"] = "true"
    headers["Accept"] = "application/json"
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        return await client.get(f"{_deck_base()}{path}", headers=headers)


@router.post("/deck/boards")
async def deck_boards(request: Request) -> dict:
    nc_user, nc_pass = await _creds(request)
    resp = await _deck_get("/boards", nc_user, nc_pass)
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Deck API {resp.status_code}: {resp.text[:200]}")
    boards = [{"id": b.get("id"), "title": b.get("title"),
               "archived": b.get("archived", False)} for b in (resp.json() or [])]
    return {"resolved_user": _caller(request), "count": len(boards), "boards": boards}


class DeckBoard(BaseModel):
    board_id: int


@router.post("/deck/board")
async def deck_board(request: Request, body: DeckBoard) -> dict:
    nc_user, nc_pass = await _creds(request)
    resp = await _deck_get(f"/boards/{body.board_id}/stacks", nc_user, nc_pass)
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Deck API {resp.status_code}: {resp.text[:200]}")
    stacks = []
    for s in (resp.json() or []):
        cards = [{"id": c.get("id"), "title": c.get("title"),
                  "archived": c.get("archived", False),
                  "duedate": c.get("duedate")} for c in (s.get("cards") or [])]
        stacks.append({"id": s.get("id"), "title": s.get("title"), "cards": cards})
    return {"resolved_user": _caller(request), "board_id": body.board_id, "stacks": stacks}


class DeckCardAdd(BaseModel):
    board_id: int
    stack_id: int
    title: str
    description: str | None = None


@router.post("/deck/add_card")
async def deck_add_card(request: Request, body: DeckCardAdd) -> dict:
    nc_user, nc_pass = await _creds(request)
    headers = _auth_header(nc_user, nc_pass)
    headers["OCS-APIRequest"] = "true"
    headers["Accept"] = "application/json"
    payload = {"title": body.title, "type": "plain", "order": 999}
    if body.description:
        payload["description"] = body.description
    url = f"{_deck_base()}/boards/{body.board_id}/stacks/{body.stack_id}/cards"
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.post(url, headers=headers, json=payload)
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=f"Deck API {resp.status_code}: {resp.text[:200]}")
    card = resp.json() or {}
    return {"ok": True, "id": card.get("id"), "title": card.get("title", body.title)}


def _deck_headers(nc_user: str, nc_pass: str) -> dict:
    h = _auth_header(nc_user, nc_pass)
    h["OCS-APIRequest"] = "true"
    h["Accept"] = "application/json"
    return h


def _owner_uid(owner) -> str:
    if isinstance(owner, dict):
        return owner.get("uid") or owner.get("primaryKey") or ""
    return owner or ""


async def _deck_card(board_id: int, stack_id: int, card_id: int,
                     nc_user: str, nc_pass: str) -> dict:
    resp = await _deck_get(f"/boards/{board_id}/stacks/{stack_id}/cards/{card_id}",
                           nc_user, nc_pass)
    if resp.status_code != 200:
        raise HTTPException(status_code=(404 if resp.status_code in (403, 404) else 502),
                            detail=f"Deck card not found ({resp.status_code})")
    return resp.json() or {}


class DeckCardUpdate(BaseModel):
    board_id: int
    stack_id: int
    card_id: int
    title: str | None = None
    description: str | None = None
    duedate: str | None = None   # ISO datetime; "" clears


@router.post("/deck/update_card")
async def deck_update_card(request: Request, body: DeckCardUpdate) -> dict:
    """Edit a Deck card's title / description / due date. Deck's update needs the
    full record, so we read-modify-write."""
    nc_user, nc_pass = await _creds(request)
    cur = await _deck_card(body.board_id, body.stack_id, body.card_id, nc_user, nc_pass)
    payload = {
        "title": body.title if body.title is not None else cur.get("title"),
        "type": cur.get("type", "plain"),
        "owner": _owner_uid(cur.get("owner")),
        "order": cur.get("order", 0),
        "description": body.description if body.description is not None else cur.get("description", ""),
        "duedate": (None if body.duedate == "" else body.duedate) if body.duedate is not None else cur.get("duedate"),
    }
    url = f"{_deck_base()}/boards/{body.board_id}/stacks/{body.stack_id}/cards/{body.card_id}"
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.put(url, headers=_deck_headers(nc_user, nc_pass), json=payload)
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=f"Deck API {resp.status_code}: {resp.text[:200]}")
    return {"ok": True, "id": body.card_id}


class DeckCardMove(BaseModel):
    board_id: int
    stack_id: int          # current stack
    card_id: int
    target_stack_id: int   # stack to move the card into
    order: int = 0         # position in the target stack (0 = top)


@router.post("/deck/move_card")
async def deck_move_card(request: Request, body: DeckCardMove) -> dict:
    """Move a card to another stack (the 'mark it done' = drag to Done column).

    The reorder route's URL {stackId} must be the *target*: Nextcloud merges URL
    route params over body params, so a source stackId in the path would override
    the body and no-op the move."""
    nc_user, nc_pass = await _creds(request)
    url = (f"{_deck_base()}/boards/{body.board_id}/stacks/{body.target_stack_id}"
           f"/cards/{body.card_id}/reorder")
    payload = {"order": body.order, "stackId": body.target_stack_id}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.put(url, headers=_deck_headers(nc_user, nc_pass), json=payload)
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=f"Deck API {resp.status_code}: {resp.text[:200]}")
    return {"ok": True, "id": body.card_id, "stack_id": body.target_stack_id}


class DeckCardArchive(BaseModel):
    board_id: int
    stack_id: int
    card_id: int
    archived: bool = True   # set False to un-archive


@router.post("/deck/archive_card")
async def deck_archive_card(request: Request, body: DeckCardArchive) -> dict:
    """Archive (or restore) a card — the reversible 'done/remove' for Deck."""
    nc_user, nc_pass = await _creds(request)
    cur = await _deck_card(body.board_id, body.stack_id, body.card_id, nc_user, nc_pass)
    payload = {
        "title": cur.get("title"),
        "type": cur.get("type", "plain"),
        "owner": _owner_uid(cur.get("owner")),
        "order": cur.get("order", 0),
        "description": cur.get("description", ""),
        "duedate": cur.get("duedate"),
        "archived": body.archived,
    }
    url = f"{_deck_base()}/boards/{body.board_id}/stacks/{body.stack_id}/cards/{body.card_id}"
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.put(url, headers=_deck_headers(nc_user, nc_pass), json=payload)
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=f"Deck API {resp.status_code}: {resp.text[:200]}")
    return {"ok": True, "id": body.card_id, "archived": body.archived}
