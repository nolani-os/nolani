"""Mail bridge — a mail becomes a task / event / contact / note.

Two halves:

1. **Bridge calls** (`/bridge/mail_to_*`): come from the Bulwark plugin
   "ClaraOS bridge". The plugin runs in Bulwark's sandbox and its `http.fetch`
   sends **no cookies** — so the Authentik session does not help here.
   Instead the plugin identifies itself with a **personal bridge token**, which
   the user stores once in the plugin settings. Caddy lets
   `/api/claraos/post/bridge/*` through without forward_auth (Caddyfile, snippet
   `claraos_site`); identity comes exclusively from the token.
   Security: a supplied `X-Claraos-User`/`X-Authentik-*` header is NEVER read here.

2. **Token management** (`/bridge/setup`, `/bridge/token`): runs in the shell,
   i.e. with a normal Authentik session (`auth.require_caller`). The token is
   shown only once; the DB stores its SHA-256 hash.

The actual work (task, event, contact, note) is not done by this router but by
the existing routers — called **internally over HTTP** with the service token
and `X-Claraos-User` (the same path as clara-tools). So there is exactly one
place that creates tasks, and the bridge inherits every rule that applies there.

The router fetches mail content itself via JMAP (`Email/get`) using the user's
mailbox credentials from `claraos_app_credentials` (app_id `mail`) — the plugin
only sends the JMAP email ID. Important: Stalwart still reports the **old**
host name in the session URL (setting `services/jmap/hostname`); the host is
replaced here with `JMAP_PUBLIC_HOST` until the Stalwart setting is changed.
"""
from __future__ import annotations

from betriebsprofil import PRODUCT_NAME
from domains_generated import BASE_DOMAIN  # setting: CLARAOS_BASE_DOMAIN
import asyncio
import base64
import email.utils as email_utils
import hashlib
import html
import json
import logging
import os
import re
import secrets
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo
from urllib.parse import urlsplit, urlunsplit

import httpx
import nh3
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from auth import require_caller
from database import get_pool, user_tx
from services import localtime
from services.download_policy import base_type, is_inline_safe, safe_media
from encryption import decrypt_credentials

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/post", tags=["post"])

JMAP_PUBLIC_HOST = os.environ.get("POST_JMAP_HOST", f"jmap.{BASE_DOMAIN}")
MAIL_PUBLIC_BASE = os.environ.get("POST_MAIL_BASE", f"https://mail.{BASE_DOMAIN}").rstrip("/")
API_INTERNAL = os.environ.get("POST_API_INTERNAL", "http://127.0.0.1:8090")
SERVICE_TOKEN = os.environ.get("CLARAOS_SERVICE_TOKEN", "")
TEXT_MAX = 3000
LOCAL_TZ = ZoneInfo(os.environ.get("POST_TZ", "Europe/Berlin"))  # container runs in UTC; "morgen 09:00" is local time

_tables_ensured = False


async def _ensure_tables() -> None:
    global _tables_ensured
    if _tables_ensured:
        return
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_post_bridge_tokens (
                username     TEXT PRIMARY KEY,
                token_hash   TEXT NOT NULL,
                created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                last_used_at TIMESTAMPTZ,
                uses         BIGINT NOT NULL DEFAULT 0
            )
        """)
    _tables_ensured = True


# ── Token ────────────────────────────────────────────────────────────────

def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def _issue_token(user: str) -> str:
    token = "pb_" + secrets.token_urlsafe(32)
    async with user_tx(user) as conn:
        await conn.execute("""
            INSERT INTO claraos_post_bridge_tokens (username, token_hash)
            VALUES ($1, $2)
            ON CONFLICT (username) DO UPDATE
               SET token_hash = EXCLUDED.token_hash, created_at = NOW(),
                   last_used_at = NULL, uses = 0
        """, user, _hash(token))
    return token


async def _user_from_token(token: str | None) -> str:
    """Identity from the bridge token — the only trust anchor here."""
    await _ensure_tables()
    if not token or not token.startswith("pb_") or len(token) > 200:
        raise HTTPException(status_code=401, detail="Brücken-Token fehlt oder ungültig")
    # Authentication path: the token hash IS the lookup key, the user is not
    # known yet — deliberately on the plain pool (no per-user RLS).
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "UPDATE claraos_post_bridge_tokens SET last_used_at = NOW(), uses = uses + 1 "
            "WHERE token_hash = $1 RETURNING username", _hash(token))
    if not row:
        raise HTTPException(status_code=401, detail=f"Brücken-Token unbekannt — in {PRODUCT_NAME} neu erzeugen")
    return row["username"]


# ── Mail credentials + JMAP ──────────────────────────────────────────────

async def _mail_credentials(user: str) -> tuple[str, str]:
    if not user:
        raise HTTPException(status_code=409, detail="Kein Mail-Konto verbunden")
    async with user_tx(user) as conn:   # row-level security (migrations/042)
        row = await conn.fetchrow("""
            SELECT credentials FROM claraos_app_credentials
            WHERE username = $1 AND app_id = 'mail' AND is_active = TRUE
            ORDER BY updated_at DESC NULLS LAST LIMIT 1
        """, user)
    if not row:
        raise HTTPException(status_code=409, detail=f"Kein Mail-Konto für {user!r} in {PRODUCT_NAME} verbunden")
    creds = decrypt_credentials(row["credentials"])
    addr, pw = creds.get("username", ""), creds.get("password", "")
    if not addr or not pw:
        raise HTTPException(status_code=409, detail="Mail-Zugang unvollständig")
    return addr, pw


def _rehost(url: str) -> str:
    """Rewrite Stalwart's session URLs to the public JMAP host."""
    p = urlsplit(url)
    return urlunsplit(("https", JMAP_PUBLIC_HOST, p.path, p.query, p.fragment))


async def _jmap_email(addr: str, pw: str, email_id: str) -> dict[str, Any]:
    auth = "Basic " + base64.b64encode(f"{addr}:{pw}".encode()).decode()
    headers = {"Authorization": auth, "Content-Type": "application/json"}
    # Important: `/.well-known/jmap` on Stalwart answers 307 → `/jmap/session`
    # (target host = old setting) — so use the session URL directly and follow redirects.
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as cl:
        r = await cl.get(f"https://{JMAP_PUBLIC_HOST}/jmap/session", headers=headers)
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail=f"JMAP-Session {r.status_code}")
        sess = r.json()
        api_url = _rehost(sess.get("apiUrl", f"https://{JMAP_PUBLIC_HOST}/jmap/"))
        account = (sess.get("primaryAccounts") or {}).get("urn:ietf:params:jmap:mail")
        if not account:
            raise HTTPException(status_code=502, detail="JMAP: kein Mail-Konto in der Session")
        body = {
            "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
            "methodCalls": [["Email/get", {
                "accountId": account,
                "ids": [email_id],
                "properties": ["id", "threadId", "mailboxIds", "subject", "from", "to", "cc",
                               "receivedAt", "sentAt", "preview", "hasAttachment", "attachments",
                               "textBody", "htmlBody", "bodyValues"],
                "fetchTextBodyValues": True,
                "maxBodyValueBytes": 20000,
            }, "0"]],
        }
        r = await cl.post(api_url, headers=headers, json=body)
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail=f"JMAP Email/get {r.status_code}")
        try:
            resp = r.json()["methodResponses"][0]
        except Exception:
            raise HTTPException(status_code=502, detail="JMAP: unlesbare Antwort")
        if resp[0] != "Email/get" or not resp[1].get("list"):
            raise HTTPException(status_code=404, detail="E-Mail nicht gefunden (ID unbekannt oder fremdes Konto)")
        return resp[1]["list"][0]


def _addr_list(items: list[dict] | None) -> str:
    out = []
    for a in items or []:
        name, mail = (a.get("name") or "").strip(), (a.get("email") or "").strip()
        out.append(f"{name} <{mail}>" if name and mail else (mail or name))
    return ", ".join(x for x in out if x)


def _plain_text(email: dict[str, Any]) -> str:
    values = email.get("bodyValues") or {}
    parts = []
    for part in email.get("textBody") or []:
        v = values.get(part.get("partId"))
        if v and v.get("value"):
            parts.append(v["value"])
    text = "\n".join(parts).strip()
    if not text:
        for part in email.get("htmlBody") or []:
            v = values.get(part.get("partId"))
            if v and v.get("value"):
                raw = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", v["value"], flags=re.S | re.I)
                raw = re.sub(r"<br\s*/?>|</p>|</div>|</tr>", "\n", raw, flags=re.I)
                text = html.unescape(re.sub(r"<[^>]+>", " ", raw))
                text = re.sub(r"[ \t]+", " ", text)
                text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
                break
    if not text:
        text = (email.get("preview") or "").strip()
    return text



def _clean(s: str) -> str:
    """Strip NUL and other control characters — Postgres rejects 0x00 in TEXT (IMAP bodies sometimes contain it)."""
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", s or "")


def _when(email: dict[str, Any]) -> str:
    raw = email.get("receivedAt") or email.get("sentAt") or ""
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(LOCAL_TZ).strftime("%d.%m.%Y %H:%M")
    except Exception:
        return raw


def _deep_link(email_id: str) -> str:
    return f"{MAIL_PUBLIC_BASE}/mail/message/{email_id}"


def _digest(email: dict[str, Any]) -> dict[str, str]:
    text = _plain_text(email)
    if len(text) > TEXT_MAX:
        text = text[:TEXT_MAX].rstrip() + " …"
    attachments = ", ".join((a.get("name") or "?") for a in (email.get("attachments") or []))
    subject = (email.get("subject") or "").strip() or "(ohne Betreff)"
    return {k: (_clean(v) if isinstance(v, str) else v) for k, v in {
        "subject": subject,
        "from": _addr_list(email.get("from")),
        "to": _addr_list(email.get("to")),
        "when": _when(email),
        "text": text,
        "attachments": attachments,
        "link": _deep_link(email["id"]),
    }.items()}


def _markdown(d: dict[str, str], note: str | None = None) -> str:
    lines = [f"**Von:** {d['from']}  ", f"**An:** {d['to']}  ", f"**Am:** {d['when']}  "]
    if d["attachments"]:
        lines.append(f"**Anhänge:** {d['attachments']}  ")
    lines.append(f"**Mail öffnen:** {d['link']}")
    if note:
        lines += ["", f"> {note.strip()}"]
    lines += ["", "---", "", d["text"] or "_(kein Text)_"]
    return "\n".join(lines)


# ── Internal calls to the other routers ──────────────────────────────────

def _internal(user: str) -> httpx.AsyncClient:
    if not SERVICE_TOKEN:
        raise HTTPException(status_code=500, detail="CLARAOS_SERVICE_TOKEN fehlt im Container")
    return httpx.AsyncClient(base_url=API_INTERNAL, timeout=30, headers={
        "X-ClaraOS-Service-Token": SERVICE_TOKEN,
        "X-Claraos-User": user,
        "Content-Type": "application/json",
    })


async def _ok_json(r: httpx.Response, was: str) -> Any:
    if r.status_code not in (200, 201):
        detail = r.text[:300]
        try:
            detail = r.json().get("detail", detail)
        except Exception:
            pass
        raise HTTPException(status_code=502, detail=f"{was}: {r.status_code} {detail}")
    return r.json()


# ── Bridge calls (token auth) ────────────────────────────────────────────

class BridgeBase(BaseModel):
    token: str
    email_id: str
    note: str | None = None


class BridgeTask(BridgeBase):
    project_id: int | None = None


class BridgeEvent(BridgeBase):
    when: str | None = None          # "YYYY-MM-DD HH:MM" | "heute HH:MM" | "morgen HH:MM" (today/tomorrow)
    duration_min: int = 30


class BridgeToken(BaseModel):
    token: str


@router.get("/bridge/ping")
async def bridge_ping():
    return {"ok": True, "service": "post-bridge"}


@router.post("/bridge/whoami")
async def bridge_whoami(body: BridgeToken):
    user = await _user_from_token(body.token)
    return {"ok": True, "user": user}


@router.post("/bridge/mail_to_task")
async def bridge_mail_to_task(body: BridgeTask):
    user = await _user_from_token(body.token)
    return await _do_mail_to_task(user, body.email_id, body.note, body.project_id)


async def _do_mail_to_task(user: str, email_id, note, project_id):
    addr, pw = await _mail_credentials(user)
    d = _digest(await _jmap_email(addr, pw, email_id))
    async with _internal(user) as cl:
        project_id = project_id
        if project_id is None:
            projects = (await _ok_json(await cl.post("/api/claraos/planner/clara/list_projects", json={}),
                                       "Projektliste")).get("projects") or []
            if not projects:
                raise HTTPException(status_code=404, detail="Kein Planner-Projekt vorhanden")
            inbox = next((p for p in projects if str(p.get("title", "")).strip().lower() == "inbox"), None)
            project_id = int((inbox or projects[0])["id"])
        created = await _ok_json(await cl.post("/api/claraos/planner/clara/create_task", json={
            "project_id": project_id, "title": d["subject"], "description": _markdown(d, note),
        }), "Aufgabe anlegen")
        task = created.get("task") or {}
        task_id = task.get("id")
        if task_id:
            await _ok_json(await cl.post("/api/claraos/planner/meta/links", json={
                "project_id": project_id, "task_id": task_id,
                "link": {"kind": "mail", "uri": d["link"], "label": d["subject"]},
            }), "Mail-Verknüpfung")
    return {"ok": True, "kind": "task", "id": task_id, "project_id": project_id,
            "title": d["subject"], "message": f"Aufgabe „{d['subject']}“ angelegt"}


def _parse_when(raw: str | None, tz_now: datetime) -> datetime:
    """"2026-09-12 09:00", "morgen 09:00", "heute 15:30"; empty = next full hour."""
    if not raw or not raw.strip():
        return (tz_now + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
    s = raw.strip().lower()
    m = re.fullmatch(r"(heute|morgen|übermorgen|\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.(?:\d{4})?)\s*(\d{1,2})(?::(\d{2}))?", s)
    if not m:
        raise HTTPException(status_code=400, detail="Zeitangabe nicht verstanden — z. B. „morgen 09:00“ oder „2026-09-12 14:30“")
    day, hh, mm = m.group(1), int(m.group(2)), int(m.group(3) or 0)
    if day == "heute":
        date = tz_now.date()
    elif day == "morgen":
        date = (tz_now + timedelta(days=1)).date()
    elif day == "übermorgen":
        date = (tz_now + timedelta(days=2)).date()
    elif "-" in day:
        date = datetime.strptime(day, "%Y-%m-%d").date()
    else:
        parts = day.rstrip(".").split(".")
        year = int(parts[2]) if len(parts) > 2 and parts[2] else tz_now.year
        date = datetime(year, int(parts[1]), int(parts[0])).date()
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        raise HTTPException(status_code=400, detail="Uhrzeit ungültig")
    return datetime.combine(date, datetime.min.time()).replace(hour=hh, minute=mm, tzinfo=tz_now.tzinfo)


@router.post("/bridge/mail_to_event")
async def bridge_mail_to_event(body: BridgeEvent):
    user = await _user_from_token(body.token)
    return await _do_mail_to_event(user, body.email_id, body.note, body.when, body.duration_min)


async def _do_mail_to_event(user: str, email_id, note, when, duration_min):
    addr, pw = await _mail_credentials(user)
    d = _digest(await _jmap_email(addr, pw, email_id))
    now = datetime.now(LOCAL_TZ)
    start = _parse_when(when, now)
    end = start + timedelta(minutes=max(5, min(duration_min, 24 * 60)))
    async with _internal(user) as cl:
        created = await _ok_json(await cl.post("/api/claraos/planner/events", json={
            "summary": d["subject"],
            "start": start.isoformat(),
            "end": end.isoformat(),
            "description": _markdown(d, note),
            "busy_status": "busy",
            "alarm_minutes": 15,
        }), "Termin anlegen")
    label = start.strftime("%a %d.%m. %H:%M")
    return {"ok": True, "kind": "event", "uid": created.get("uid"), "id": created.get("uid"),
            "calendar": created.get("calendar"),
            "start": start.isoformat(), "start_lokal": localtime.label(start), "title": d["subject"],
            "message": f"Termin „{d['subject']}“ am {label} angelegt" + (
                f" — {created['warning']}" if created.get("warning") else "")}


@router.post("/bridge/mail_to_contact")
async def bridge_mail_to_contact(body: BridgeBase):
    user = await _user_from_token(body.token)
    return await _do_mail_to_contact(user, body.email_id, body.note)


async def _do_mail_to_contact(user: str, email_id, note):
    addr, pw = await _mail_credentials(user)
    email = await _jmap_email(addr, pw, email_id)
    sender = next(iter(email.get("from") or []), None) or {}
    mail_addr = (sender.get("email") or "").strip().lower()
    name = (sender.get("name") or "").strip()
    if not mail_addr:
        raise HTTPException(status_code=422, detail="Absender ohne E-Mail-Adresse")
    async with _internal(user) as cl:
        existing = await _ok_json(await cl.get("/api/claraos/contacts", params={"q": mail_addr, "limit": 20}),
                                  "Kontaktsuche")
        for k in (existing.get("contacts") or []):
            # List row = projection (`_zeile`); depending on the version the address
            # is in data.mails or in the search text — so match roughly over the whole row.
            if mail_addr in json.dumps(k, ensure_ascii=False).lower():
                return {"ok": True, "kind": "contact", "id": k.get("id"), "existing": True,
                        "message": f"{name or mail_addr} ist schon in den Kontakten"}
        vor, nach = (name.split(" ", 1) + [""])[:2] if name else ("", "")
        data = {
            "namen": {"vorname": vor, "nachname": nach, "anzeigename": name or mail_addr},
            "mails": [{"wert": mail_addr, "label": "privat", "pref": True}],
            "notizen": f"Aus E-Mail „{(email.get('subject') or '').strip()}“ vom {_when(email)}",
        }
        created = await _ok_json(await cl.post("/api/claraos/contacts", json={"data": data}), "Kontakt anlegen")
    kontakt = created.get("kontakt") or created
    return {"ok": True, "kind": "contact", "id": kontakt.get("id"), "existing": False,
            "message": f"Kontakt „{name or mail_addr}“ angelegt"}


@router.post("/bridge/mail_to_note")
async def bridge_mail_to_note(body: BridgeBase):
    user = await _user_from_token(body.token)
    return await _do_mail_to_note(user, body.email_id, body.note)


async def _do_mail_to_note(user: str, email_id, note):
    addr, pw = await _mail_credentials(user)
    d = _digest(await _jmap_email(addr, pw, email_id))
    async with _internal(user) as cl:
        created = await _ok_json(await cl.post("/api/claraos/knowledge/objects", json={
            "type": "note", "title": d["subject"], "body": _markdown(d, note),
        }), "Notiz anlegen")
    obj = created.get("object") or {}
    return {"ok": True, "kind": "note", "id": obj.get("id"), "title": d["subject"],
            "message": f"Notiz „{d['subject']}“ in der Wissens-App angelegt"}


# ── Token management (shell, Authentik session) ──────────────────────────

@router.post("/bridge/token")
async def create_token(request: Request):
    user = require_caller(request)
    await _ensure_tables()
    token = await _issue_token(user)
    return {"ok": True, "token": token, "user": user}


@router.get("/bridge/token")
async def token_status(request: Request):
    user = require_caller(request)
    await _ensure_tables()
    async with user_tx(user) as conn:
        row = await conn.fetchrow(
            "SELECT created_at, last_used_at, uses FROM claraos_post_bridge_tokens WHERE username = $1", user)
    return {"ok": True, "user": user, "exists": bool(row),
            **({"created_at": row["created_at"].isoformat(), "uses": row["uses"],
                "last_used_at": row["last_used_at"].isoformat() if row["last_used_at"] else None} if row else {})}


@router.delete("/bridge/token")
async def revoke_token(request: Request):
    user = require_caller(request)
    await _ensure_tables()
    async with user_tx(user) as conn:
        await conn.execute("DELETE FROM claraos_post_bridge_tokens WHERE username = $1", user)
    return {"ok": True}


@router.get("/bridge/setup", response_class=HTMLResponse)
async def setup_page(request: Request, neu: int = 0):
    """Setup page: shows the token exactly once."""
    user = require_caller(request)
    await _ensure_tables()
    token = await _issue_token(user) if neu else None
    status = await token_status(request)
    esc = html.escape
    body = f"""<!doctype html><meta charset="utf-8"><title>Post-Brücke einrichten</title>
<style>body{{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#222}}
code,.tok{{font-family:ui-monospace,monospace;background:#f3f3f3;padding:.15rem .4rem;border-radius:4px}}
.tok{{display:block;padding:.8rem;word-break:break-all;font-size:1.05rem;border:1px solid #ccc}}
a.btn{{display:inline-block;padding:.5rem 1rem;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none}}
ol li{{margin:.4rem 0}}</style>
<h1>Post-Brücke für <code>{esc(user)}</code></h1>
<p>Die Brücke verbindet die Mail-App (Bulwark) mit Planner, Kalender, Kontakten und Wissen:
„→ Aufgabe“, „→ Termin“, „→ Kontakt“, „→ Notiz“ direkt an der E-Mail.</p>
"""
    if token:
        body += f"""<h2>Dein neuer Brücken-Token</h2>
<p>Er wird <strong>nur dieses eine Mal</strong> angezeigt. Ein früherer Token ist ab jetzt ungültig.</p>
<span class="tok">{esc(token)}</span>
<h2>So hinterlegst du ihn</h2>
<ol>
<li>Mail-App öffnen → Einstellungen → <strong>Plugins</strong> → „{PRODUCT_NAME}-Brücke“ aktivieren (Berechtigungen bestätigen).</li>
<li>Bei den Plugin-Einstellungen im Feld <strong>{PRODUCT_NAME}-Token</strong> den Wert oben einfügen. Die {PRODUCT_NAME}-Adresse ist vorausgefüllt.</li>
<li>Eine E-Mail öffnen: über dem Text erscheint die Leiste mit den vier Knöpfen.</li>
</ol>"""
    else:
        st = "vorhanden" if status.get("exists") else "noch keiner"
        used = f", {status.get('uses', 0)}× benutzt" if status.get("exists") else ""
        body += f"""<p>Token-Stand: <strong>{st}</strong>{used}.</p>
<p><a class="btn" href="?neu=1">Neuen Token erzeugen</a></p>
<p>Ein neuer Token macht den alten ungültig. Der Token gehört nur dir und steht nur in deinen Plugin-Einstellungen.</p>"""
    return HTMLResponse(body)


# ── Clara tools (service token + X-Claraos-User, like clara-tools) ───────────
#
# Clara knows emails through the IMAP tools in `mail.py` (uid + mailbox), not
# through JMAP IDs. These routes therefore take uid/mailbox, read the mail via
# IMAP (the same function as `get_message`) and look up the JMAP ID only for
# the deep link, via the Message-ID header.

from routers import mail as _mail  # noqa: E402


class ClaraMailRef(BaseModel):
    uid: str
    mailbox: str = "INBOX"
    note: str | None = None
    project_id: int | None = None
    when: str | None = None
    duration_min: int = 30


async def _jmap_id_by_message_id(addr: str, pw: str, message_id: str) -> str | None:
    if not message_id:
        return None
    auth = "Basic " + base64.b64encode(f"{addr}:{pw}".encode()).decode()
    headers = {"Authorization": auth, "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as cl:
            r = await cl.get(f"https://{JMAP_PUBLIC_HOST}/jmap/session", headers=headers)
            if r.status_code != 200:
                return None
            sess = r.json()
            api_url = _rehost(sess.get("apiUrl", f"https://{JMAP_PUBLIC_HOST}/jmap/"))
            account = (sess.get("primaryAccounts") or {}).get("urn:ietf:params:jmap:mail")
            # Important: Stalwart does not find anything with the `header` filter (empty),
            # but full-text search on the bare Message-ID does — so check hits against the header.
            needle = message_id.strip().strip("<>")
            body = {"using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
                    "methodCalls": [
                        ["Email/query", {"accountId": account, "filter": {"text": needle}, "limit": 3}, "0"],
                        ["Email/get", {"accountId": account, "#ids": {"resultOf": "0", "name": "Email/query", "path": "/ids"},
                                       "properties": ["id", "messageId"]}, "1"]]}
            r = await cl.post(api_url, headers=headers, json=body)
            for name, data, _ in r.json().get("methodResponses", []):
                if name == "Email/get":
                    for e in data.get("list") or []:
                        if needle in [x.strip("<>") for x in (e.get("messageId") or [])]:
                            return e["id"]
            return None
    except Exception as e:  # the deep link is a convenience, not a must
        logger.info("post: JMAP-ID-Suche fehlgeschlagen: %s", e)
        return None


async def _digest_from_imap(user: str, uid: str, mailbox: str) -> dict[str, str]:
    addr, pw = await _mail_credentials(user)
    m = await asyncio.to_thread(_mail._get_message_sync, addr, pw, mailbox, uid)
    # Fetch the Message-ID for the deep link (small second IMAP access, headers only)
    def _msgid() -> str:
        M = _mail._imap_connect(addr, pw)
        try:
            M.select(f'"{mailbox}"', readonly=True)
            typ, data = M.uid("FETCH", uid.encode(), "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")
            blob = next((p[1] for p in (data or []) if isinstance(p, tuple)), b"")
            return blob.decode(errors="replace").split(":", 1)[-1].strip() if blob else ""
        finally:
            M.logout()
    message_id = await asyncio.to_thread(_msgid)
    jmap_id = await _jmap_id_by_message_id(addr, pw, message_id)
    text = (m.get("body") or "").strip()
    if len(text) > TEXT_MAX:
        text = text[:TEXT_MAX].rstrip() + " …"
    return {k: (_clean(v) if isinstance(v, str) else v) for k, v in {
        "subject": (m.get("subject") or "").strip() or "(ohne Betreff)",
        "from": m.get("from") or "", "to": m.get("to") or "",
        "when": m.get("date") or "", "text": text,
        "attachments": ", ".join(m.get("attachments") or []),
        "link": _deep_link(jmap_id) if jmap_id else f"{MAIL_PUBLIC_BASE}/mail",
        "sender_email": (email_utils.parseaddr(m.get("from") or "")[1] or "").lower(),
        "sender_name": email_utils.parseaddr(m.get("from") or "")[0] or "",
    }.items()}


@router.post("/clara/mail_to_task")
async def clara_mail_to_task(body: ClaraMailRef, request: Request):
    user = require_caller(request)
    d = await _digest_from_imap(user, body.uid, body.mailbox)
    async with _internal(user) as cl:
        project_id = body.project_id
        if project_id is None:
            projects = (await _ok_json(await cl.post("/api/claraos/planner/clara/list_projects", json={}),
                                       "Projektliste")).get("projects") or []
            if not projects:
                raise HTTPException(status_code=404, detail="Kein Planner-Projekt vorhanden")
            inbox = next((p for p in projects if str(p.get("title", "")).strip().lower() == "inbox"), None)
            project_id = int((inbox or projects[0])["id"])
        created = await _ok_json(await cl.post("/api/claraos/planner/clara/create_task", json={
            "project_id": project_id, "title": d["subject"], "description": _markdown(d, body.note),
        }), "Aufgabe anlegen")
        task_id = (created.get("task") or {}).get("id")
        if task_id:
            await _ok_json(await cl.post("/api/claraos/planner/meta/links", json={
                "project_id": project_id, "task_id": task_id,
                "link": {"kind": "mail", "uri": d["link"], "label": d["subject"]},
            }), "Mail-Verknüpfung")
    return {"ok": True, "kind": "task", "id": task_id, "project_id": project_id, "title": d["subject"],
            "message": f"Aufgabe „{d['subject']}“ angelegt (Projekt {project_id})"}


@router.post("/clara/mail_to_event")
async def clara_mail_to_event(body: ClaraMailRef, request: Request):
    user = require_caller(request)
    d = await _digest_from_imap(user, body.uid, body.mailbox)
    now = datetime.now(LOCAL_TZ)
    start = _parse_when(body.when, now)
    end = start + timedelta(minutes=max(5, min(body.duration_min, 24 * 60)))
    async with _internal(user) as cl:
        created = await _ok_json(await cl.post("/api/claraos/planner/events", json={
            "summary": d["subject"], "start": start.isoformat(),
            "end": end.isoformat(), "description": _markdown(d, body.note),
            "busy_status": "busy", "alarm_minutes": 15,
        }), "Termin anlegen")
    return {"ok": True, "kind": "event", "uid": created.get("uid"), "calendar": created.get("calendar"),
            "start": start.isoformat(), "start_lokal": localtime.label(start), "title": d["subject"],
            "message": f"Termin „{d['subject']}“ am {start.strftime('%a %d.%m. %H:%M')} angelegt"}


@router.post("/clara/mail_to_note")
async def clara_mail_to_note(body: ClaraMailRef, request: Request):
    user = require_caller(request)
    d = await _digest_from_imap(user, body.uid, body.mailbox)
    async with _internal(user) as cl:
        created = await _ok_json(await cl.post("/api/claraos/knowledge/objects", json={
            "type": "note", "title": d["subject"], "body": _markdown(d, body.note),
        }), "Notiz anlegen")
    obj = created.get("object") or {}
    return {"ok": True, "kind": "note", "id": obj.get("id"), "title": d["subject"],
            "message": f"Notiz „{d['subject']}“ in der Wissens-App angelegt"}


# ═════════════════════════════════════════════════════════════════════════════
# Mail app (native client in the shell): per-user JMAP proxy
# ═════════════════════════════════════════════════════════════════════════════
#
# The shell does NOT talk to Stalwart itself (no second login, no CORS, one
# data path for humans and Clara). All routes here run with the normal
# ClaraOS session (`require_caller`) and take the mailbox credentials from
# `claraos_app_credentials`. The JMAP session is cached briefly per user.

from fastapi import Query
from fastapi.responses import StreamingResponse

_SESSION_TTL = 300.0
_sessions: dict[str, tuple[float, dict[str, Any]]] = {}

LIST_PROPS = ["id", "threadId", "mailboxIds", "keywords", "from", "to", "subject",
              "receivedAt", "sentAt", "preview", "hasAttachment", "size"]
FULL_PROPS = LIST_PROPS + ["cc", "bcc", "replyTo", "sender", "messageId", "inReplyTo", "references",
                           "textBody", "htmlBody", "attachments", "bodyValues", "headers"]


async def _jmap_session(user: str) -> dict[str, Any]:
    import time
    now = time.time()
    hit = _sessions.get(user)
    if hit and now - hit[0] < _SESSION_TTL:
        return hit[1]
    addr, pw = await _mail_credentials(user)
    auth = "Basic " + base64.b64encode(f"{addr}:{pw}".encode()).decode()
    headers = {"Authorization": auth, "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as cl:
        r = await cl.get(f"https://{JMAP_PUBLIC_HOST}/jmap/session", headers=headers)
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"JMAP-Session {r.status_code}")
    sess = r.json()
    account = (sess.get("primaryAccounts") or {}).get("urn:ietf:params:jmap:mail")
    if not account:
        raise HTTPException(status_code=502, detail="JMAP: kein Mail-Konto in der Session")
    info = {
        "headers": headers,
        "api_url": _rehost(sess.get("apiUrl", f"https://{JMAP_PUBLIC_HOST}/jmap/")),
        "download_url": _rehost(sess.get("downloadUrl", "")),
        "account": account,
        "address": addr,
        # Stalwart lists ALL accounts this user may open here — their own plus
        # every group mailbox and every share.
        "accounts": sess.get("accounts") or {},
    }
    _sessions[user] = (now, info)
    return info


async def _konto(user: str, account_id: str | None) -> str:
    """Which mailbox is meant? Without a value, the user's own.

    Important: the parameter is not a permission. A foreign account is only
    accepted if Stalwart itself offers it to the user in their own session —
    anyone who is not a member of the group and has no share does not see the
    account there and does not get through here. The decision is thus made on
    the mail server, not in this line.
    """
    s = await _jmap_session(user)
    if not account_id or account_id == s["account"]:
        return s["account"]
    if account_id not in (s.get("accounts") or {}):
        raise HTTPException(status_code=403, detail="Auf dieses Postfach hast du keinen Zugriff")
    return account_id


async def _jmap(user: str, calls: list[list[Any]], using: list[str] | None = None,
                fehler_erlauben: bool = False) -> list[list[Any]]:
    """One JMAP request; returns methodResponses. Error responses become 502.

    `fehler_erlauben=True` returns the error response instead — needed for cases
    where a rejected request is not an error but a fallback (e.g. a sort order
    the server does not support).
    """
    body = {"using": using or ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
            "methodCalls": calls}
    # A cached session can carry an outdated mailbox password (password reset,
    # account re-created). On 401 drop it and retry once with fresh credentials.
    for attempt in (1, 2):
        s = await _jmap_session(user)
        async with httpx.AsyncClient(timeout=40) as cl:
            r = await cl.post(s["api_url"], headers=s["headers"], json=body)
        if r.status_code != 401:
            break
        _sessions.pop(user, None)
    if r.status_code == 401:
        raise HTTPException(status_code=502, detail="JMAP: Zugang abgelehnt (Postfach-Passwort prüfen)")
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"JMAP {r.status_code}: {r.text[:200]}")
    resp = r.json().get("methodResponses") or []
    for name, data, _tag in resp:
        if name == "error":
            if fehler_erlauben:
                return resp
            raise HTTPException(status_code=502, detail=f"JMAP-Fehler: {data.get('type')} {data.get('description') or ''}".strip())
    return resp


def _by_tag(resp: list[list[Any]], tag: str) -> dict[str, Any]:
    for name, data, t in resp:
        if t == tag:
            return data
    return {}


ROLE_NAMES = {"inbox": "Posteingang", "sent": "Gesendet", "drafts": "Entwürfe", "junk": "Spam",
              "trash": "Papierkorb", "archive": "Archiv", "all": "Alle", "important": "Wichtig"}
ROLE_ORDER = {"inbox": 0, "drafts": 1, "sent": 2, "archive": 3, "junk": 8, "trash": 9}


def _mailbox_row(m: dict[str, Any]) -> dict[str, Any]:
    role = m.get("role")
    return {"id": m["id"], "name": ROLE_NAMES.get(role, m.get("name")), "raw_name": m.get("name"),
            "role": role, "parent_id": m.get("parentId"), "total": m.get("totalEmails", 0),
            "unread": m.get("unreadEmails", 0), "sort": (ROLE_ORDER.get(role, 5), (m.get("name") or "").lower()),
            "may_delete": bool((m.get("myRights") or {}).get("mayDelete", True))}


def _email_row(e: dict[str, Any]) -> dict[str, Any]:
    kw = e.get("keywords") or {}
    return {
        "id": e["id"], "thread_id": e.get("threadId"), "mailbox_ids": list((e.get("mailboxIds") or {}).keys()),
        "from": e.get("from") or [], "to": e.get("to") or [], "subject": _clean(e.get("subject") or ""),
        "received_at": e.get("receivedAt"), "sent_at": e.get("sentAt"), "preview": _clean(e.get("preview") or ""),
        "has_attachment": bool(e.get("hasAttachment")), "size": e.get("size"),
        "unread": not kw.get("$seen"), "flagged": bool(kw.get("$flagged")), "answered": bool(kw.get("$answered")),
        "draft": bool(kw.get("$draft")), "junk": bool(kw.get("$junk")),
        "pinned": bool(kw.get("$pinned")), "snoozed": bool(kw.get("$snoozed")),
        "labels": sorted(k[7:] for k in kw if k.startswith("$label:")),
        "keywords": sorted(kw.keys()),
    }


@router.get("/mailboxes")
async def post_mailboxes(request: Request,
                         account_id: str | None = Query(None, description="Gruppenpostfach/Freigabe; leer = eigenes")):
    user = require_caller(request)
    konto = await _konto(user, account_id)
    s = await _jmap_session(user)
    resp = await _jmap(user, [["Mailbox/get", {"accountId": konto}, "m"]])
    rows = [_mailbox_row(m) for m in _by_tag(resp, "m").get("list") or []]
    rows.sort(key=lambda r: r["sort"])
    for r in rows:
        r.pop("sort", None)
    fremd = konto != s["account"]
    adresse = ((s.get("accounts") or {}).get(konto) or {}).get("name") if fremd else s["address"]
    return {"mailboxes": rows, "address": adresse or s["address"],
            "account_id": konto, "fremdes_konto": fremd}


# ── Sorting ──────────────────────────────────────────────────────────────────
# Outlook offers date/from/category/flag/size/importance/subject/type.
# JMAP (RFC 8621 §4.4.2) supports: receivedAt, sentAt, size, from, to, subject,
# hasKeyword. "Category" and "importance" have NO JMAP equivalent and are
# deliberately not offered — better four sort orders that really sort than
# eight of which half silently end up sorting by date.
SORT_FELDER: dict[str, tuple[str, str | None]] = {
    "datum": ("receivedAt", None),
    "von": ("from", None),
    "betreff": ("subject", None),
    "groesse": ("size", None),
    "kennzeichen": ("hasKeyword", "$flagged"),
}


def _sortierung(sort: str | None, order: str | None) -> tuple[str, bool, list[dict[str, Any]]]:
    """UI request -> JMAP comparator. Unknown values fall back to date."""
    feld = (sort or "datum").strip().lower()
    if feld not in SORT_FELDER:
        feld = "datum"
    prop, keyword = SORT_FELDER[feld]
    aufsteigend = (order or "desc").strip().lower() == "asc"
    erste: dict[str, Any] = {"property": prop, "isAscending": aufsteigend}
    if keyword:
        erste["keyword"] = keyword
    spec = [erste]
    # Secondary key: otherwise the order within the same sender or the same
    # flag is random and changes between two pages.
    if prop != "receivedAt":
        spec.append({"property": "receivedAt", "isAscending": False})
    return feld, aufsteigend, spec


@router.get("/messages")
async def post_messages(request: Request,
                        mailbox: str | None = Query(None, description="Mailbox-ID; leer = Posteingang"),
                        q: str | None = Query(None), unread: bool = Query(False), flagged: bool = Query(False),
                        position: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200),
                        threads: bool = Query(True),
                        sort: str | None = Query(None, description="datum|von|betreff|groesse|kennzeichen"),
                        order: str | None = Query(None, description="asc|desc (Vorgabe desc)"),
                        has_attachment: bool = Query(False, description="nur Mails mit Dateianhang"),
                        account_id: str | None = Query(None, description="Gruppenpostfach/Freigabe; leer = eigenes")):
    user = require_caller(request)
    s = await _jmap_session(user)
    konto = await _konto(user, account_id)
    filt: dict[str, Any] = {}
    if mailbox and mailbox != "-":
        filt["inMailbox"] = mailbox
    if q and q.strip():
        filt["text"] = q.strip()
    if unread:
        filt["notKeyword"] = "$seen"
    if flagged:
        filt["hasKeyword"] = "$flagged"
    if has_attachment:
        filt["hasAttachment"] = True
    label = request.query_params.get("label")
    if label:
        filt["hasKeyword"] = f"$label:{label.strip()}"
    if request.query_params.get("snoozed") == "true":
        filt = {"hasKeyword": "$snoozed"}
        mailbox = "-"
    if not mailbox and not (q and q.strip()) and not label:
        # No folder: inbox (by role) — otherwise spam/trash would be included.
        mresp = await _jmap(user, [["Mailbox/query", {"accountId": konto, "filter": {"role": "inbox"}}, "q"]])
        ids = _by_tag(mresp, "q").get("ids") or []
        if ids:
            filt["inMailbox"] = ids[0]
    feld, aufsteigend, sort_spec = _sortierung(sort, order)

    def _calls(spec: list[dict[str, Any]]) -> list[list[Any]]:
        return [
            ["Email/query", {"accountId": konto, "filter": filt, "sort": spec,
                             "collapseThreads": threads, "position": position, "limit": limit,
                             "calculateTotal": True}, "q"],
            ["Email/get", {"accountId": konto, "#ids": {"resultOf": "q", "name": "Email/query", "path": "/ids"},
                           "properties": LIST_PROPS}, "g"],
        ]

    # Warning: Stalwart rejects some sort requests with `unsupportedSort` (seen
    #    with EmailSubmission). Then do NOT silently return date order — that would
    #    be a lie in the UI — but fall back AND say so.
    sortierung_abgelehnt = False
    resp = await _jmap(user, _calls(sort_spec), fehler_erlauben=(feld != "datum"))
    if any(name == "error" for name, _d, _t in resp):
        art = next((d.get("type") for n, d, _t in resp if n == "error"), "")
        if feld == "datum":
            raise HTTPException(status_code=502, detail=f"JMAP-Fehler: {art}")
        sortierung_abgelehnt = True
        feld, aufsteigend, sort_spec = _sortierung(None, None)
        resp = await _jmap(user, _calls(sort_spec))

    qd, gd = _by_tag(resp, "q"), _by_tag(resp, "g")
    reihenfolge = {i: n for n, i in enumerate(qd.get("ids") or [])}
    rows = sorted((_email_row(e) for e in gd.get("list") or []), key=lambda r: reihenfolge.get(r["id"], 1e9))
    return {"messages": rows, "total": qd.get("total"), "position": qd.get("position", position),
            "query_state": qd.get("queryState"),
            "sort": feld, "order": "asc" if aufsteigend else "desc",
            "sort_unsupported": sortierung_abgelehnt}


# Mail HTML is written by strangers. It reaches the sandboxed reading pane and,
# when replying or forwarding, the composer — a contenteditable on the shell
# origin, where a surviving event handler runs with the user's session. Regexes
# cannot parse HTML (`<svg/onload>`, `src="x"onerror=`, `java&#115;cript:` all
# slipped through the earlier version), so an allowlist parser decides.
_MAIL_TAGS = (set(nh3.ALLOWED_TAGS) | {"font", "center"}) - {"style"}
_MAIL_ATTRS = {
    "*": {"style", "class", "dir", "lang", "title", "align", "valign", "width", "height", "bgcolor", "color"},
    "a": {"href", "hreflang"},
    "img": {"src", "alt", "border"},
    "font": {"face", "size"},
    "table": {"border", "cellpadding", "cellspacing"},
    "td": {"colspan", "rowspan"},
    "th": {"colspan", "rowspan"},
    "ol": {"start", "type"},
    "blockquote": {"cite"},
}
# Layout and typography only: no `position`, `z-index` or similar, which would let
# a quote overlay the composer's own controls.
_MAIL_STYLE_PROPS = {
    "color", "background-color", "background", "font", "font-family", "font-size", "font-style",
    "font-weight", "line-height", "letter-spacing", "text-align", "text-decoration", "text-indent",
    "text-transform", "vertical-align", "white-space", "word-break", "direction",
    "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
    "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
    "border", "border-top", "border-right", "border-bottom", "border-left", "border-color",
    "border-style", "border-width", "border-collapse", "border-spacing", "border-radius",
    "width", "max-width", "min-width", "height", "max-height", "min-height", "display", "list-style-type",
}
_MAIL_SCHEMES = {"http", "https", "mailto", "tel", "cid"}


def _sanitize_html(html_src: str, *, style_blocks: bool = False) -> str:
    """Allowlist-sanitise mail HTML.

    `style_blocks` keeps `<style>` elements for the reading pane, which renders
    in a sandboxed iframe without scripts; the CSS inside is not inspected, so it
    must never reach the composer on the shell origin.
    """
    tags = _MAIL_TAGS | {"style"} if style_blocks else _MAIL_TAGS
    return nh3.clean(
        html_src, tags=tags, clean_content_tags={"script"} if style_blocks else {"script", "style"},
        attributes=_MAIL_ATTRS, url_schemes=_MAIL_SCHEMES, filter_style_properties=_MAIL_STYLE_PROPS,
        link_rel="noopener noreferrer")


@router.get("/message/{email_id}")
async def post_message(email_id: str, request: Request, mark_read: bool = Query(True),
                       account_id: str | None = Query(None, description="Gruppenpostfach/Freigabe; leer = eigenes")):
    user = require_caller(request)
    s = await _jmap_session(user)
    konto = await _konto(user, account_id)
    calls: list[list[Any]] = [
        ["Email/get", {"accountId": konto, "ids": [email_id], "properties": FULL_PROPS,
                       "fetchAllBodyValues": True, "maxBodyValueBytes": 800_000}, "g"],
    ]
    resp = await _jmap(user, calls)
    lst = _by_tag(resp, "g").get("list") or []
    if not lst:
        raise HTTPException(status_code=404, detail="E-Mail nicht gefunden")
    e = lst[0]
    values = e.get("bodyValues") or {}
    html_parts, text_parts = [], []
    for part in e.get("htmlBody") or []:
        v = values.get(part.get("partId"))
        if v and v.get("value"):
            html_parts.append(v["value"])
    for part in e.get("textBody") or []:
        v = values.get(part.get("partId"))
        if v and v.get("value"):
            text_parts.append(v["value"])
    html_out = _sanitize_html("\n".join(html_parts), style_blocks=True) if html_parts else ""
    text_out = _clean("\n".join(text_parts))
    # Conversation: all mails of the thread (lightweight rows)
    thread_rows: list[dict[str, Any]] = []
    if e.get("threadId"):
        tresp = await _jmap(user, [
            ["Thread/get", {"accountId": konto, "ids": [e["threadId"]]}, "t"],
            ["Email/get", {"accountId": konto, "#ids": {"resultOf": "t", "name": "Thread/get", "path": "/list/*/emailIds"},
                           "properties": LIST_PROPS}, "tg"],
        ])
        thread_rows = sorted((_email_row(x) for x in _by_tag(tresp, "tg").get("list") or []),
                             key=lambda r: r.get("received_at") or "")
    if mark_read and not (e.get("keywords") or {}).get("$seen"):
        try:
            await _jmap(user, [["Email/set", {"accountId": konto,
                                              "update": {email_id: {"keywords/$seen": True}}}, "s"]])
        except HTTPException:
            pass
    row = _email_row(e)
    row.update({
        "cc": e.get("cc") or [], "bcc": e.get("bcc") or [], "reply_to": e.get("replyTo") or [],
        "message_id": e.get("messageId") or [], "in_reply_to": e.get("inReplyTo") or [],
        "html": html_out, "text": text_out,
        "attachments": [{"blob_id": a.get("blobId"), "name": a.get("name") or "Anhang", "type": a.get("type"),
                         "size": a.get("size"), "cid": a.get("cid"), "inline": bool(a.get("disposition") == "inline")}
                        for a in e.get("attachments") or []],
        "thread": thread_rows,
        "mail_app_url": _deep_link(email_id),
    })
    return {"message": row}


@router.get("/blob/{blob_id}")
async def post_blob(blob_id: str, request: Request, name: str = Query("anhang"), type: str = Query("application/octet-stream"),
                    account_id: str | None = Query(None, description="Gruppenpostfach/Freigabe; leer = eigenes")):
    user = require_caller(request)
    s = await _jmap_session(user)
    konto = await _konto(user, account_id)
    from urllib.parse import quote
    # The type comes from the attachment metadata, i.e. from the sender, and the
    # JMAP server echoes it as Content-Type: only pass it on when it is safe.
    asked_type = base_type(type) if is_inline_safe(type) else "application/octet-stream"
    url = (s["download_url"].replace("{accountId}", konto).replace("{blobId}", blob_id)
           .replace("{name}", quote(name)).replace("{type}", quote(asked_type, safe="")))
    cl = httpx.AsyncClient(timeout=120, follow_redirects=True)
    r = await cl.send(cl.build_request("GET", url, headers={"Authorization": s["headers"]["Authorization"]}), stream=True)
    if r.status_code != 200:
        await r.aclose(); await cl.aclose()
        raise HTTPException(status_code=502, detail=f"Download {r.status_code}")
    async def gen():
        try:
            async for chunk in r.aiter_bytes():
                yield chunk
        finally:
            await r.aclose(); await cl.aclose()
    safe_name = re.sub(r"[^\w.\- ]+", "_", name)[:120] or "anhang"
    media_type, inline, security = safe_media(r.headers.get("content-type", asked_type), want_inline=True)
    disposition = "inline" if inline else "attachment"
    return StreamingResponse(gen(), media_type=media_type,
                             headers={"Content-Disposition": f'{disposition}; filename="{safe_name}"', **security})


class PostSet(BaseModel):
    ids: list[str]
    account_id: str | None = None       # group mailbox/share; empty = own
    add_keywords: list[str] = []
    remove_keywords: list[str] = []
    move_to: str | None = None          # mailbox ID
    move_to_role: str | None = None     # "archive" | "trash" | "junk" | "inbox"
    destroy: bool = False


@router.post("/set")
async def post_set(body: PostSet, request: Request):
    user = require_caller(request)
    s = await _jmap_session(user)
    konto = await _konto(user, body.account_id)
    if not body.ids:
        raise HTTPException(status_code=400, detail="ids fehlt")
    target = body.move_to
    if body.move_to_role and not target:
        mresp = await _jmap(user, [["Mailbox/get", {"accountId": konto}, "m"]])
        boxes = _by_tag(mresp, "m").get("list") or []
        hit = next((m for m in boxes if m.get("role") == body.move_to_role), None)
        if not hit and body.move_to_role == "archive":
            # No archive folder: create it (once)
            cresp = await _jmap(user, [["Mailbox/set", {"accountId": konto,
                                                       "create": {"a": {"name": "Archive", "role": "archive"}}}, "c"]])
            created = (_by_tag(cresp, "c").get("created") or {}).get("a") or {}
            target = created.get("id")
        else:
            target = hit["id"] if hit else None
        if not target:
            raise HTTPException(status_code=404, detail=f"Kein Ordner mit Rolle {body.move_to_role!r}")
    if body.destroy:
        resp = await _jmap(user, [["Email/set", {"accountId": konto, "destroy": body.ids}, "s"]])
        d = _by_tag(resp, "s")
        return {"ok": True, "destroyed": d.get("destroyed") or [], "not_destroyed": d.get("notDestroyed") or {}}
    patch: dict[str, Any] = {}
    for k in body.add_keywords:
        patch[f"keywords/{k}"] = True
    for k in body.remove_keywords:
        patch[f"keywords/{k}"] = None
    if target:
        patch["mailboxIds"] = {target: True}
    if not patch:
        raise HTTPException(status_code=400, detail="nichts zu ändern")
    resp = await _jmap(user, [["Email/set", {"accountId": konto, "update": {i: patch for i in body.ids}}, "s"]])
    d = _by_tag(resp, "s")
    return {"ok": True, "updated": list((d.get("updated") or {}).keys()), "not_updated": d.get("notUpdated") or {}}


# ── Bridge actions from the mail app (ClaraOS session instead of token) ─────

class AppMailRef(BaseModel):
    email_id: str
    note: str | None = None
    project_id: int | None = None
    when: str | None = None
    duration_min: int = 30


@router.post("/app/mail_to_task")
async def app_mail_to_task(body: AppMailRef, request: Request):
    user = require_caller(request)
    return await _do_mail_to_task(user, body.email_id, body.note, body.project_id)


@router.post("/app/mail_to_event")
async def app_mail_to_event(body: AppMailRef, request: Request):
    user = require_caller(request)
    return await _do_mail_to_event(user, body.email_id, body.note, body.when, body.duration_min)


@router.post("/app/mail_to_contact")
async def app_mail_to_contact(body: AppMailRef, request: Request):
    user = require_caller(request)
    return await _do_mail_to_contact(user, body.email_id, body.note)


@router.post("/app/mail_to_note")
async def app_mail_to_note(body: AppMailRef, request: Request):
    user = require_caller(request)
    return await _do_mail_to_note(user, body.email_id, body.note)


# ═════════════════════════════════════════════════════════════════════════════
# Writing: identities, upload, drafts, sending with undo
# ═════════════════════════════════════════════════════════════════════════════
#
# Important: delayed sending + "undo send" do not come from our own queue but
# from Stalwart's FUTURERELEASE: `EmailSubmission/set` with `holdfor` (seconds)
# or `holduntil` holds the mail back on the server (`undoStatus: pending`);
# `undoStatus: canceled` withdraws it. Verified with a probe (pending → canceled).

from fastapi import UploadFile, File

USING_SUB = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"]


def _identity_row(i: dict[str, Any]) -> dict[str, Any]:
    return {"id": i["id"], "name": i.get("name") or "", "email": i.get("email") or "",
            "reply_to": i.get("replyTo") or [], "bcc": i.get("bcc") or [],
            "text_signature": i.get("textSignature") or "", "html_signature": i.get("htmlSignature") or "",
            "may_delete": bool(i.get("mayDelete", False))}


async def _roles(user: str) -> dict[str, str]:
    s = await _jmap_session(user)
    r = await _jmap(user, [["Mailbox/get", {"accountId": s["account"], "properties": ["id", "role"]}, "m"]])
    return {m.get("role"): m["id"] for m in _by_tag(r, "m").get("list") or [] if m.get("role")}


@router.get("/identities")
async def post_identities(request: Request):
    user = require_caller(request)
    s = await _jmap_session(user)
    r = await _jmap(user, [["Identity/get", {"accountId": s["account"]}, "i"]], using=USING_SUB)
    rows = [_identity_row(i) for i in _by_tag(r, "i").get("list") or []]
    # The primary address (with full name) first
    rows.sort(key=lambda x: (0 if x["email"].endswith("@" + os.environ.get("STALWART_MAIL_DOMAIN", BASE_DOMAIN)) and "." in x["email"].split("@")[0] else 1, x["email"]))
    return {"identities": rows, "address": s["address"]}


class IdentityPatch(BaseModel):
    name: str | None = None
    text_signature: str | None = None
    html_signature: str | None = None
    reply_to: list[dict] | None = None


@router.put("/identities/{identity_id}")
async def post_identity_update(identity_id: str, body: IdentityPatch, request: Request):
    user = require_caller(request)
    s = await _jmap_session(user)
    patch: dict[str, Any] = {}
    if body.name is not None:
        patch["name"] = body.name
    if body.text_signature is not None:
        patch["textSignature"] = body.text_signature
    if body.html_signature is not None:
        patch["htmlSignature"] = body.html_signature
    if body.reply_to is not None:
        patch["replyTo"] = body.reply_to or None
    if not patch:
        raise HTTPException(status_code=400, detail="nichts zu ändern")
    r = await _jmap(user, [["Identity/set", {"accountId": s["account"], "update": {identity_id: patch}}, "u"]], using=USING_SUB)
    d = _by_tag(r, "u")
    if d.get("notUpdated"):
        raise HTTPException(status_code=502, detail=f"Identität nicht geändert: {d['notUpdated']}")
    return {"ok": True}


@router.post("/upload")
async def post_upload(request: Request, file: UploadFile = File(...)):
    """Upload an attachment to Stalwart → blobId for draft/send."""
    user = require_caller(request)
    s = await _jmap_session(user)
    data = await file.read()
    if len(data) > 50 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Anhang größer als 50 MB")
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as cl:
        sess = (await cl.get(f"https://{JMAP_PUBLIC_HOST}/jmap/session", headers=s["headers"])).json()
        url = _rehost(sess.get("uploadUrl", "")).replace("{accountId}", s["account"])
        r = await cl.post(url, content=data, headers={"Authorization": s["headers"]["Authorization"],
                                                       "Content-Type": file.content_type or "application/octet-stream"})
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=f"Upload {r.status_code}")
    j = r.json()
    return {"blob_id": j.get("blobId"), "name": file.filename or "anhang", "type": j.get("type") or file.content_type,
            "size": j.get("size", len(data))}


class DraftIn(BaseModel):
    draft_id: str | None = None          # existing draft → gets replaced
    identity_id: str
    to: list[dict] = []                  # {name?, email}
    cc: list[dict] = []
    bcc: list[dict] = []
    subject: str = ""
    html: str = ""
    text: str = ""
    attachments: list[dict] = []         # {blob_id, name, type, size?}
    in_reply_to: str | None = None       # JMAP email ID of the original (reply)
    forward_of: str | None = None
    request_mdn: bool = False


class SendIn(DraftIn):
    delay_s: int = 10                    # undo window; 0 = immediately
    send_at: str | None = None           # ISO time (local time, Europe/Berlin) for "send later"


def _addr_objs(items: list[dict]) -> list[dict]:
    out = []
    for a in items or []:
        e = (a.get("email") or "").strip()
        if e:
            nm = (a.get("name") or "").strip()
            out.append({"name": nm, "email": e} if nm else {"email": e})
    return out


def _html_to_text(html_src: str) -> str:
    raw = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html_src or "", flags=re.S | re.I)
    raw = re.sub(r"<br\s*/?>|</p>|</div>|</li>|</tr>|</h[1-6]>", "\n", raw, flags=re.I)
    raw = re.sub(r"<li[^>]*>", "• ", raw, flags=re.I)
    text = html.unescape(re.sub(r"<[^>]+>", "", raw))
    text = re.sub(r"[ \t]+\n", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


async def _build_email(user: str, body: DraftIn, drafts_id: str, identity: dict[str, Any]) -> dict[str, Any]:
    text = body.text.strip() or _html_to_text(body.html)
    html_src = body.html.strip() or ("<div>" + html.escape(text).replace("\n", "<br>") + "</div>")
    email: dict[str, Any] = {
        "mailboxIds": {drafts_id: True},
        "keywords": {"$draft": True, "$seen": True},
        "from": [({"name": identity["name"], "email": identity["email"]} if identity.get("name") else {"email": identity["email"]})],
        "to": _addr_objs(body.to),
        "subject": body.subject.strip(),
        "textBody": [{"partId": "t", "type": "text/plain"}],
        "htmlBody": [{"partId": "h", "type": "text/html"}],
        "bodyValues": {"t": {"value": text}, "h": {"value": html_src}},
    }
    for key, items in (("cc", body.cc), ("bcc", body.bcc)):
        objs = _addr_objs(items)
        if objs:
            email[key] = objs
    if identity.get("replyTo"):
        email["replyTo"] = identity["replyTo"]
    if body.attachments:
        email["attachments"] = [{"blobId": a["blob_id"], "type": a.get("type") or "application/octet-stream",
                                 "name": a.get("name") or "anhang", "disposition": "attachment"} for a in body.attachments if a.get("blob_id")]
    if body.request_mdn:
        email["header:Disposition-Notification-To:asAddresses"] = [{"email": identity["email"]}]
    src_id = body.in_reply_to or body.forward_of
    if src_id:
        s = await _jmap_session(user)
        r = await _jmap(user, [["Email/get", {"accountId": s["account"], "ids": [src_id],
                                              "properties": ["messageId", "references"]}, "g"]])
        lst = _by_tag(r, "g").get("list") or []
        if lst:
            mid = lst[0].get("messageId") or []
            refs = (lst[0].get("references") or []) + mid
            if body.in_reply_to and mid:
                email["inReplyTo"] = mid
            if refs:
                email["references"] = refs[-20:]
    return email


async def _identity(user: str, identity_id: str) -> dict[str, Any]:
    s = await _jmap_session(user)
    r = await _jmap(user, [["Identity/get", {"accountId": s["account"], "ids": [identity_id]}, "i"]], using=USING_SUB)
    lst = _by_tag(r, "i").get("list") or []
    if not lst:
        raise HTTPException(status_code=404, detail="Identität unbekannt")
    return lst[0]


async def _create_email(user: str, body: DraftIn) -> tuple[str, dict[str, str]]:
    s = await _jmap_session(user)
    roles = await _roles(user)
    if "drafts" not in roles:
        raise HTTPException(status_code=502, detail="Kein Entwürfe-Ordner")
    identity = await _identity(user, body.identity_id)
    email = await _build_email(user, body, roles["drafts"], identity)
    calls: list[list[Any]] = [["Email/set", {"accountId": s["account"], "create": {"e": email}}, "c"]]
    if body.draft_id:
        calls[0][1]["destroy"] = [body.draft_id]
    r = await _jmap(user, calls)
    d = _by_tag(r, "c")
    created = (d.get("created") or {}).get("e")
    if not created:
        raise HTTPException(status_code=502, detail=f"Entwurf nicht angelegt: {d.get('notCreated')}")
    return created["id"], roles


@router.post("/draft")
async def post_draft(body: DraftIn, request: Request):
    user = require_caller(request)
    eid, _ = await _create_email(user, body)
    return {"ok": True, "draft_id": eid}


@router.post("/send")
async def post_send(body: SendIn, request: Request):
    user = require_caller(request)
    if not _addr_objs(body.to) and not _addr_objs(body.cc) and not _addr_objs(body.bcc):
        raise HTTPException(status_code=400, detail="Kein Empfänger")
    s = await _jmap_session(user)
    eid, roles = await _create_email(user, body)
    identity = await _identity(user, body.identity_id)
    params: dict[str, str] = {}
    if body.send_at:
        try:
            when = datetime.fromisoformat(body.send_at)
            if when.tzinfo is None:
                when = when.replace(tzinfo=LOCAL_TZ)
        except ValueError:
            raise HTTPException(status_code=400, detail="send_at unlesbar (ISO-Zeit erwartet)")
        secs = int((when - datetime.now(LOCAL_TZ)).total_seconds())
        if secs < 0:
            raise HTTPException(status_code=400, detail="Sendezeit liegt in der Vergangenheit")
        params["holdfor"] = str(min(secs, 30 * 24 * 3600))
    elif body.delay_s > 0:
        params["holdfor"] = str(min(max(body.delay_s, 5), 600))
    rcpt = [{"email": a["email"]} for a in _addr_objs(body.to) + _addr_objs(body.cc) + _addr_objs(body.bcc)]
    sub: dict[str, Any] = {"emailId": eid, "identityId": identity["id"],
                           "envelope": {"mailFrom": {"email": identity["email"], "parameters": params or None},
                                        "rcptTo": rcpt}}
    on_ok: dict[str, Any] = {f"mailboxIds/{roles['sent']}": True, f"mailboxIds/{roles['drafts']}": None, "keywords/$draft": None} if roles.get("sent") else {"keywords/$draft": None}
    r = await _jmap(user, [["EmailSubmission/set", {"accountId": s["account"], "create": {"s": sub},
                                                    "onSuccessUpdateEmail": {"#s": on_ok}}, "s"]], using=USING_SUB)
    d = _by_tag(r, "s")
    created = (d.get("created") or {}).get("s")
    if not created:
        # Draft is kept; return the error
        raise HTTPException(status_code=502, detail=f"Nicht gesendet: {d.get('notCreated')}")
    return {"ok": True, "submission_id": created["id"], "email_id": eid, "send_at": created.get("sendAt"),
            "undo_until_s": int(params.get("holdfor", "0")), "message": "Gesendet" if not params else
            ("Wird gesendet um " + (created.get("sendAt") or "") if body.send_at else f"Wird in {params['holdfor']} s gesendet")}


@router.post("/send/{submission_id}/undo")
async def post_send_undo(submission_id: str, request: Request):
    user = require_caller(request)
    s = await _jmap_session(user)
    roles = await _roles(user)
    r = await _jmap(user, [["EmailSubmission/set", {"accountId": s["account"], "update": {submission_id: {"undoStatus": "canceled"}}}, "u"],
                           ["EmailSubmission/get", {"accountId": s["account"], "ids": [submission_id]}, "g"]], using=USING_SUB)
    u = _by_tag(r, "u")
    if u.get("notUpdated"):
        raise HTTPException(status_code=409, detail="Zu spät — die Mail ist schon unterwegs")
    g = (_by_tag(r, "g").get("list") or [{}])[0]
    eid = g.get("emailId")
    if eid and roles.get("drafts"):
        await _jmap(user, [["Email/set", {"accountId": s["account"], "update": {eid: {
            f"mailboxIds/{roles['drafts']}": True, **({f"mailboxIds/{roles['sent']}": None} if roles.get("sent") else {}),
            "keywords/$draft": True}}}, "b"]])
    return {"ok": True, "draft_id": eid, "message": "Senden rückgängig — liegt wieder bei den Entwürfen"}


@router.get("/outbox")
async def post_outbox(request: Request):
    """Held-back submissions (undo window or "send later")."""
    user = require_caller(request)
    s = await _jmap_session(user)
    # Important: Stalwart's query filter `undoStatus` returns nothing — fetch all, filter here.
    r = await _jmap(user, [
        ["EmailSubmission/query", {"accountId": s["account"], "limit": 50}, "q"],
        ["EmailSubmission/get", {"accountId": s["account"], "#ids": {"resultOf": "q", "name": "EmailSubmission/query", "path": "/ids"}}, "g"],
    ], using=USING_SUB)
    subs = [x for x in (_by_tag(r, "g").get("list") or []) if x.get("undoStatus") == "pending"]
    ids = [x.get("emailId") for x in subs if x.get("emailId")]
    subjects: dict[str, dict] = {}
    if ids:
        r2 = await _jmap(user, [["Email/get", {"accountId": s["account"], "ids": ids, "properties": ["id", "subject", "to"]}, "e"]])
        subjects = {e["id"]: e for e in _by_tag(r2, "e").get("list") or []}
    return {"outbox": [{"submission_id": x["id"], "email_id": x.get("emailId"), "send_at": x.get("sendAt"),
                        "subject": (subjects.get(x.get("emailId"), {}).get("subject") or ""),
                        "to": subjects.get(x.get("emailId"), {}).get("to") or []} for x in subs]}


@router.get("/reply/{email_id}")
async def post_reply_source(email_id: str, request: Request, mode: str = Query("reply", pattern="^(reply|all|forward)$")):
    """Template for reply/forward: recipients, subject, quote, attachments (when forwarding)."""
    user = require_caller(request)
    s = await _jmap_session(user)
    r = await _jmap(user, [["Email/get", {"accountId": s["account"], "ids": [email_id], "properties": FULL_PROPS,
                                          "fetchAllBodyValues": True, "maxBodyValueBytes": 400_000}, "g"]])
    lst = _by_tag(r, "g").get("list") or []
    if not lst:
        raise HTTPException(status_code=404, detail="E-Mail nicht gefunden")
    e = lst[0]
    me = (s["address"] or "").lower()
    ident_r = await _jmap(user, [["Identity/get", {"accountId": s["account"]}, "i"]], using=USING_SUB)
    mine = {(i.get("email") or "").lower() for i in _by_tag(ident_r, "i").get("list") or []} | {me}
    frm = e.get("from") or []
    reply_to = e.get("replyTo") or frm
    subj = (e.get("subject") or "").strip()
    values = e.get("bodyValues") or {}
    html_src = "".join(values.get(p.get("partId"), {}).get("value", "") for p in e.get("htmlBody") or [])
    text_src = "".join(values.get(p.get("partId"), {}).get("value", "") for p in e.get("textBody") or [])
    if not text_src and html_src:
        text_src = _html_to_text(html_src)
    when = _when(e)
    who = _addr_list(frm)
    if mode == "forward":
        to, cc = [], []
        subject = subj if re.match(r"^\s*(fwd?|wg)\s*:", subj, re.I) else f"Fwd: {subj}"
        head_html = ("<div>---------- Weitergeleitete Nachricht ----------<br>"
                     f"<b>Von:</b> {html.escape(who)}<br><b>Datum:</b> {html.escape(when)}<br>"
                     f"<b>Betreff:</b> {html.escape(subj)}<br><b>An:</b> {html.escape(_addr_list(e.get('to')))}</div><br>")
        quote_html = head_html + (_sanitize_html(html_src) if html_src else "<div>" + html.escape(text_src).replace("\n", "<br>") + "</div>")
        quote_text = f"---------- Weitergeleitete Nachricht ----------\nVon: {who}\nDatum: {when}\nBetreff: {subj}\nAn: {_addr_list(e.get('to'))}\n\n{text_src}"
        atts = [{"blob_id": a.get("blobId"), "name": a.get("name") or "Anhang", "type": a.get("type"), "size": a.get("size")}
                for a in e.get("attachments") or [] if a.get("blobId") and not (a.get("disposition") == "inline" and a.get("cid"))]
    else:
        to = [a for a in reply_to if (a.get("email") or "").lower() not in mine] or reply_to
        cc = []
        if mode == "all":
            seen = {(a.get("email") or "").lower() for a in to} | mine
            for a in (e.get("to") or []) + (e.get("cc") or []):
                em = (a.get("email") or "").lower()
                if em and em not in seen:
                    cc.append(a); seen.add(em)
        subject = subj if re.match(r"^\s*(re|aw)\s*:", subj, re.I) else f"Re: {subj}"
        intro = f"Am {when} schrieb {who}:"
        quote_html = f"<br><br><div>{html.escape(intro)}</div><blockquote style=\"border-left:2px solid #999;margin:0 0 0 .5em;padding-left:.8em\">" + \
                     (_sanitize_html(html_src) if html_src else "<div>" + html.escape(text_src).replace("\n", "<br>") + "</div>") + "</blockquote>"
        quote_text = f"\n\n{intro}\n" + "\n".join("> " + ln for ln in text_src.splitlines())
        atts = []
    return {"to": [{"name": a.get("name"), "email": a.get("email")} for a in to],
            "cc": [{"name": a.get("name"), "email": a.get("email")} for a in cc],
            "subject": subject, "quote_html": quote_html, "quote_text": quote_text,
            "in_reply_to": email_id if mode != "forward" else None, "forward_of": email_id if mode == "forward" else None,
            "attachments": atts}


@router.get("/suggest")
async def post_suggest(request: Request, q: str = Query("", max_length=80)):
    """Recipient suggestions: contacts app + addresses from recently sent mails."""
    user = require_caller(request)
    ql = q.strip().lower()
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    try:
        async with _internal(user) as cl:
            k = await cl.get("/api/claraos/contacts", params={"q": ql or " ", "limit": 20})
            if k.status_code == 200:
                for c in (k.json().get("contacts") or []):
                    name = c.get("anzeigename") or ""
                    for m in ((c.get("data") or {}).get("mails") or []):
                        em = (m.get("wert") or "").strip().lower()
                        if em and em not in seen and (not ql or ql in em or ql in name.lower()):
                            seen.add(em); out.append({"name": name, "email": em, "source": "kontakte"})
    except Exception as ex:
        logger.info("post/suggest: Kontakte nicht erreichbar: %s", ex)
    try:
        s = await _jmap_session(user)
        roles = await _roles(user)
        if roles.get("sent"):
            r = await _jmap(user, [
                ["Email/query", {"accountId": s["account"], "filter": {"inMailbox": roles["sent"]},
                                 "sort": [{"property": "receivedAt", "isAscending": False}], "limit": 60}, "q"],
                ["Email/get", {"accountId": s["account"], "#ids": {"resultOf": "q", "name": "Email/query", "path": "/ids"},
                               "properties": ["to", "cc"]}, "g"]])
            for e in _by_tag(r, "g").get("list") or []:
                for a in (e.get("to") or []) + (e.get("cc") or []):
                    em = (a.get("email") or "").strip().lower(); nm = a.get("name") or ""
                    if em and em not in seen and (not ql or ql in em or ql in nm.lower()):
                        seen.add(em); out.append({"name": nm, "email": em, "source": "gesendet"})
    except HTTPException:
        pass
    return {"suggestions": out[:12]}


# ── Text snippets from the knowledge app ────────────────────────────────────
#
# Convention (no new table): a note in the knowledge app whose title starts
# with "Baustein:" is a text snippet for mails. The rest of the title is the
# display name; the note text (Markdown) is inserted as simple HTML. This way
# users maintain snippets where they already write.

SNIPPET_PREFIX = re.compile(r"^\s*baustein\s*:\s*", re.I)


def _md_to_html(md: str) -> str:
    """Small Markdown converter for snippets: paragraphs, line breaks, **bold**,
    *italic*, links, - lists. Not full Markdown — deliberately."""
    def inline(t: str) -> str:
        t = html.escape(t)
        t = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2">\1</a>', t)
        t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
        t = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<i>\1</i>", t)
        t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
        return t
    out: list[str] = []
    for block in re.split(r"\n\s*\n", (md or "").strip()):
        lines = block.splitlines()
        if lines and all(re.match(r"^\s*[-*]\s+", ln) for ln in lines):
            items = [inline(re.sub(r"^\s*[-*]\s+", "", ln)) for ln in lines]
            out.append("<ul>" + "".join("<li>" + it + "</li>" for it in items) + "</ul>")
        elif lines and re.match(r"^#{1,3}\s+", lines[0]):
            head = inline(re.sub(r"^#{1,3}\s+", "", lines[0]))
            rest = "<div>" + "<br>".join(inline(x) for x in lines[1:]) + "</div>" if len(lines) > 1 else ""
            out.append("<div><b>" + head + "</b></div>" + rest)
        else:
            out.append("<div>" + "<br>".join(inline(x) for x in lines) + "</div>")
    return "".join(out)


@router.get("/snippets")
async def post_snippets(request: Request):
    user = require_caller(request)
    out: list[dict[str, Any]] = []
    async with _internal(user) as cl:
        r = await cl.get("/api/claraos/knowledge/objects", params={"type": "note", "limit": 200})
        if r.status_code != 200:
            return {"snippets": out}
        for o in (r.json().get("objects") or []):
            title = o.get("title") or ""
            if not SNIPPET_PREFIX.match(title):
                continue
            g = await cl.get(f"/api/claraos/knowledge/objects/{o['id']}")
            body = ((g.json().get("object") or {}).get("body") or "") if g.status_code == 200 else ""
            out.append({"id": o["id"], "title": SNIPPET_PREFIX.sub("", title).strip() or title,
                        "html": _md_to_html(body), "text": body})
    out.sort(key=lambda x: x["title"].lower())
    return {"snippets": out}


# ═════════════════════════════════════════════════════════════════════════════
# Rules (Sieve), out-of-office, sweep, blocking
# ═════════════════════════════════════════════════════════════════════════════
#
# Rules are stored as JSON in `claraos_post_rules` (source of truth for the UI)
# and translated into ONE Sieve script "claraos", which is uploaded and
# activated via JMAP. Verified: upload (application/sieve) → SieveScript/set
# create + onSuccessActivateScript; delete only after
# onSuccessDeactivateScript. Out-of-office = VacationResponse (singleton).

USING_SIEVE = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:sieve"]
USING_VAC = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:vacationresponse"]
SCRIPT_NAME = "claraos"
_rules_table_ready = False


async def _ensure_rules_table() -> None:
    global _rules_table_ready
    if _rules_table_ready:
        return
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_post_rules (
                username   TEXT PRIMARY KEY,
                rules      JSONB NOT NULL DEFAULT '[]',
                script     TEXT,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
    _rules_table_ready = True


class RuleCondition(BaseModel):
    field: str = "from"        # from|to|subject|body|any|size_over_kb|has_attachment|list_id
    op: str = "contains"       # contains|is|starts|ends (text) — ignored for size/has_attachment
    value: str = ""


class RuleAction(BaseModel):
    type: str = "move"         # move|flag|read|delete|junk|redirect|stop|label
    mailbox_id: str | None = None
    mailbox_name: str | None = None
    address: str | None = None
    label: str | None = None


class Rule(BaseModel):
    id: str
    name: str
    enabled: bool = True
    match: str = "all"         # all|any
    conditions: list[RuleCondition] = []
    actions: list[RuleAction] = []


class RulesIn(BaseModel):
    rules: list[Rule]


def _sq(s: str) -> str:
    return '"' + (s or "").replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ") + '"'


def _cond_sieve(c: RuleCondition) -> str | None:
    v = (c.value or "").strip()
    op = {"contains": ":contains", "is": ":is", "starts": ":matches", "ends": ":matches"}.get(c.op, ":contains")
    if c.op == "starts":
        v = v + "*"
    elif c.op == "ends":
        v = "*" + v
    f = c.field
    if f in ("from", "to", "cc", "subject"):
        return f'header {op} {_sq(f)} {_sq(v)}' if v else None
    if f == "list_id":
        return f'header :contains "list-id" {_sq(v)}' if v else None
    if f == "body":
        return f'body :text {op} {_sq(v)}' if v else None
    if f == "any":
        return f'anyof(header {op} ["from","to","cc","subject"] {_sq(v)}, body :text {op} {_sq(v)})' if v else None
    if f == "size_over_kb":
        try:
            return f"size :over {int(float(v)) * 1024}"
        except ValueError:
            return None
    if f == "has_attachment":
        return 'anyof(header :contains "content-type" "multipart/mixed", header :contains "content-disposition" "attachment")'
    return None


def _action_sieve(a: RuleAction, roles: dict[str, str]) -> str | None:
    if a.type == "move" and a.mailbox_id:
        return f'fileinto :mailboxid {_sq(a.mailbox_id)} {_sq(a.mailbox_name or "INBOX")};'
    if a.type == "junk" and roles.get("junk"):
        return f'fileinto :mailboxid {_sq(roles["junk"])} "Junk Mail";'
    if a.type == "flag":
        return 'addflag "\\\\Flagged";'
    if a.type == "read":
        return 'addflag "\\\\Seen";'
    if a.type == "label" and a.label:
        return f'addflag {_sq("$label:" + a.label.strip())};'
    if a.type == "delete":
        return "discard;"
    if a.type == "redirect" and a.address:
        return f'redirect :copy {_sq(a.address.strip())};'
    if a.type == "stop":
        return "stop;"
    return None


def _rules_to_sieve(rules: list[Rule], roles: dict[str, str]) -> str:
    blocks: list[str] = []
    for r in rules:
        if not r.enabled:
            continue
        conds = [c for c in (_cond_sieve(x) for x in r.conditions) if c]
        acts = [a for a in (_action_sieve(x, roles) for x in r.actions) if a]
        if not conds or not acts:
            continue
        test = conds[0] if len(conds) == 1 else ("allof(" if r.match != "any" else "anyof(") + ", ".join(conds) + ")"
        body = "\n".join("    " + a for a in acts)
        # Move/delete stop processing, so that subsequent rules do not deliver twice
        if any(x.type in ("move", "delete", "junk") for x in r.actions) and "stop;" not in acts:
            body += "\n    stop;"
        blocks.append(f"# {r.name.replace(chr(10), ' ')}\nif {test} {{\n{body}\n}}")
    head = 'require ["fileinto", "imap4flags", "mailboxid", "body", "copy", "envelope"];\n# Erzeugt von ' + PRODUCT_NAME + ' Post — bitte in der Post-App bearbeiten, nicht hier.\n'
    return head + "\n".join(blocks) + ("\n" if blocks else "")


async def _sieve_scripts(user: str) -> list[dict[str, Any]]:
    s = await _jmap_session(user)
    r = await _jmap(user, [["SieveScript/get", {"accountId": s["account"]}, "g"]], using=USING_SIEVE)
    return _by_tag(r, "g").get("list") or []


async def _sieve_install(user: str, script: str) -> dict[str, Any]:
    s = await _jmap_session(user)
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as cl:
        sess = (await cl.get(f"https://{JMAP_PUBLIC_HOST}/jmap/session", headers=s["headers"])).json()
        up = _rehost(sess["uploadUrl"]).replace("{accountId}", s["account"])
        r = await cl.post(up, content=script.encode(), headers={"Authorization": s["headers"]["Authorization"], "Content-Type": "application/sieve"})
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=f"Sieve-Upload {r.status_code}")
    blob = r.json()["blobId"]
    v = await _jmap(user, [["SieveScript/validate", {"accountId": s["account"], "blobId": blob}, "v"]], using=USING_SIEVE)
    err = _by_tag(v, "v").get("error")
    if err:
        raise HTTPException(status_code=422, detail=f"Sieve ungültig: {err.get('description') or err}")
    existing = next((x for x in await _sieve_scripts(user) if x.get("name") == SCRIPT_NAME), None)
    if existing:
        r2 = await _jmap(user, [["SieveScript/set", {"accountId": s["account"], "update": {existing["id"]: {"blobId": blob}},
                                                    "onSuccessActivateScript": existing["id"]}, "u"]], using=USING_SIEVE)
        d = _by_tag(r2, "u")
        if d.get("notUpdated"):
            raise HTTPException(status_code=502, detail=f"Sieve nicht aktualisiert: {d['notUpdated']}")
        return {"script_id": existing["id"], "active": True}
    r2 = await _jmap(user, [["SieveScript/set", {"accountId": s["account"], "create": {"c": {"name": SCRIPT_NAME, "blobId": blob}},
                                                "onSuccessActivateScript": "#c"}, "c"]], using=USING_SIEVE)
    d = _by_tag(r2, "c")
    if not (d.get("created") or {}).get("c"):
        raise HTTPException(status_code=502, detail=f"Sieve nicht angelegt: {d.get('notCreated')}")
    return {"script_id": d["created"]["c"]["id"], "active": True}


@router.get("/rules")
async def post_rules_get(request: Request):
    user = require_caller(request)
    await _ensure_rules_table()
    async with user_tx(user) as conn:
        row = await conn.fetchrow("SELECT rules, script, updated_at FROM claraos_post_rules WHERE username = $1", user)
    rules = (json.loads(row["rules"]) if row and isinstance(row["rules"], str) else (row["rules"] if row else [])) or []
    scripts = await _sieve_scripts(user)
    ours = next((x for x in scripts if x.get("name") == SCRIPT_NAME), None)
    others = [x["name"] for x in scripts if x.get("name") != SCRIPT_NAME and x.get("isActive")]
    return {"rules": rules, "script": (row["script"] if row else None) or "", "installed": bool(ours),
            "active": bool(ours and ours.get("isActive")), "foreign_active": others,
            "updated_at": row["updated_at"].isoformat() if row else None}


@router.put("/rules")
async def post_rules_put(body: RulesIn, request: Request):
    user = require_caller(request)
    await _ensure_rules_table()
    roles = await _roles(user)
    script = _rules_to_sieve(body.rules, roles)
    result = await _sieve_install(user, script)
    async with user_tx(user) as conn:
        await conn.execute("""
            INSERT INTO claraos_post_rules (username, rules, script, updated_at) VALUES ($1, $2::jsonb, $3, NOW())
            ON CONFLICT (username) DO UPDATE SET rules = EXCLUDED.rules, script = EXCLUDED.script, updated_at = NOW()
        """, user, json.dumps([r.model_dump() for r in body.rules]), script)
    return {"ok": True, "script": script, **result}


# ── Out-of-office ────────────────────────────────────────────────────────

class VacationIn(BaseModel):
    enabled: bool = False
    from_date: str | None = None   # ISO date/datetime (local time)
    to_date: str | None = None
    subject: str | None = None
    text: str = ""


def _vac_row(v: dict[str, Any]) -> dict[str, Any]:
    return {"enabled": bool(v.get("isEnabled")), "from_date": v.get("fromDate"), "to_date": v.get("toDate"),
            "subject": v.get("subject") or "", "text": v.get("textBody") or "", "html": v.get("htmlBody") or ""}


@router.get("/vacation")
async def post_vacation_get(request: Request):
    user = require_caller(request)
    s = await _jmap_session(user)
    r = await _jmap(user, [["VacationResponse/get", {"accountId": s["account"]}, "v"]], using=USING_VAC)
    lst = _by_tag(r, "v").get("list") or [{}]
    return {"vacation": _vac_row(lst[0])}


def _iso_utc(raw: str | None, end_of_day: bool) -> str | None:
    if not raw:
        return None
    try:
        d = datetime.fromisoformat(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Datum unlesbar: {raw}")
    if len(raw) <= 10:
        d = d.replace(hour=23, minute=59, second=59) if end_of_day else d.replace(hour=0, minute=0, second=0)
    if d.tzinfo is None:
        d = d.replace(tzinfo=LOCAL_TZ)
    return d.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%SZ")


@router.put("/vacation")
async def post_vacation_put(body: VacationIn, request: Request):
    user = require_caller(request)
    s = await _jmap_session(user)
    patch = {"isEnabled": body.enabled, "fromDate": _iso_utc(body.from_date, False), "toDate": _iso_utc(body.to_date, True),
             "subject": (body.subject or "").strip() or None, "textBody": body.text.strip() or None,
             "htmlBody": ("<div>" + html.escape(body.text.strip()).replace("\n", "<br>") + "</div>") if body.text.strip() else None}
    r = await _jmap(user, [["VacationResponse/set", {"accountId": s["account"], "update": {"singleton": patch}}, "u"]], using=USING_VAC)
    d = _by_tag(r, "u")
    if d.get("notUpdated"):
        raise HTTPException(status_code=502, detail=f"Abwesenheit nicht gespeichert: {d['notUpdated']}")
    return await post_vacation_get(request)


# ── Sweep + blocking ─────────────────────────────────────────────────────

class SweepIn(BaseModel):
    sender: str                         # email address
    mailbox: str | None = None          # folder ID; empty = inbox
    action: str = "delete"              # delete|archive
    future: bool = False                # also create a rule


@router.post("/sweep")
async def post_sweep(body: SweepIn, request: Request):
    user = require_caller(request)
    s = await _jmap_session(user)
    roles = await _roles(user)
    sender = body.sender.strip().lower()
    if not sender:
        raise HTTPException(status_code=400, detail="Absender fehlt")
    box = body.mailbox or roles.get("inbox")
    r = await _jmap(user, [["Email/query", {"accountId": s["account"], "filter": {"inMailbox": box, "from": sender}, "limit": 500}, "q"]])
    ids = _by_tag(r, "q").get("ids") or []
    moved = 0
    if ids:
        if body.action == "archive":
            target = roles.get("archive")
            if not target:
                cresp = await _jmap(user, [["Mailbox/set", {"accountId": s["account"], "create": {"a": {"name": "Archive", "role": "archive"}}}, "c"]])
                target = ((_by_tag(cresp, "c").get("created") or {}).get("a") or {}).get("id")
        else:
            target = roles.get("trash")
        if not target:
            raise HTTPException(status_code=404, detail="Zielordner fehlt")
        r2 = await _jmap(user, [["Email/set", {"accountId": s["account"], "update": {i: {"mailboxIds": {target: True}} for i in ids}}, "s"]])
        moved = len((_by_tag(r2, "s").get("updated") or {}))
    rule_added = False
    if body.future:
        await _ensure_rules_table()
        async with user_tx(user) as conn:
            row = await conn.fetchrow("SELECT rules FROM claraos_post_rules WHERE username = $1", user)
        rules = [Rule(**x) for x in ((json.loads(row["rules"]) if row and isinstance(row["rules"], str) else (row["rules"] if row else [])) or [])]
        if not any(any(c.field == "from" and c.value.lower() == sender for c in r.conditions) for r in rules):
            act = RuleAction(type="delete") if body.action != "archive" else RuleAction(type="move", mailbox_id=target, mailbox_name="Archive")
            rules.append(Rule(id=secrets.token_hex(4), name=f"Aufräumen: {sender}", conditions=[RuleCondition(field="from", op="contains", value=sender)], actions=[act]))
            script = _rules_to_sieve(rules, roles)
            await _sieve_install(user, script)
            async with user_tx(user) as conn:
                await conn.execute("""
                    INSERT INTO claraos_post_rules (username, rules, script, updated_at) VALUES ($1, $2::jsonb, $3, NOW())
                    ON CONFLICT (username) DO UPDATE SET rules = EXCLUDED.rules, script = EXCLUDED.script, updated_at = NOW()
                """, user, json.dumps([x.model_dump() for x in rules]), script)
            rule_added = True
    what = "archiviert" if body.action == "archive" else "gelöscht"
    return {"ok": True, "count": moved, "rule_added": rule_added,
            "message": f"{moved} Mail(s) von {sender} {what}" + (" — künftige landen automatisch dort" if rule_added else "")}


class BlockIn(BaseModel):
    sender: str


@router.post("/block")
async def post_block(body: BlockIn, request: Request):
    """Block a sender = rule "Blockiert: x" (discard) + move existing mails to trash."""
    user = require_caller(request)
    sender = body.sender.strip().lower()
    if not sender or "@" not in sender:
        raise HTTPException(status_code=400, detail="Adresse fehlt")
    await _ensure_rules_table()
    roles = await _roles(user)
    async with user_tx(user) as conn:
        row = await conn.fetchrow("SELECT rules FROM claraos_post_rules WHERE username = $1", user)
    rules = [Rule(**x) for x in ((json.loads(row["rules"]) if row and isinstance(row["rules"], str) else (row["rules"] if row else [])) or [])]
    if not any(r.name.startswith("Blockiert: ") and any(c.value.lower() == sender for c in r.conditions) for r in rules):
        rules.insert(0, Rule(id=secrets.token_hex(4), name=f"Blockiert: {sender}",
                             conditions=[RuleCondition(field="from", op="contains", value=sender)], actions=[RuleAction(type="delete")]))
    script = _rules_to_sieve(rules, roles)
    await _sieve_install(user, script)
    async with user_tx(user) as conn:
        await conn.execute("""
            INSERT INTO claraos_post_rules (username, rules, script, updated_at) VALUES ($1, $2::jsonb, $3, NOW())
            ON CONFLICT (username) DO UPDATE SET rules = EXCLUDED.rules, script = EXCLUDED.script, updated_at = NOW()
        """, user, json.dumps([x.model_dump() for x in rules]), script)
    sw = await post_sweep(SweepIn(sender=sender, action="delete"), request)
    return {"ok": True, "message": f"{sender} blockiert — {sw['count']} vorhandene Mail(s) in den Papierkorb"}


# ═════════════════════════════════════════════════════════════════════════════
# Push (EventSource proxy), snooze, label filter
# ═════════════════════════════════════════════════════════════════════════════

from fastapi.responses import StreamingResponse as _SR  # noqa: F811 (already imported, for clarity)


@router.get("/events")
async def post_events(request: Request):
    """SSE proxy for Stalwart's JMAP EventSource: `state` events (Email/Mailbox/
    EmailSubmission) are passed 1:1 to the shell, which then reloads.
    Caddy: separate handle block with flush_interval -1 (like ntfy/sse)."""
    user = require_caller(request)
    s = await _jmap_session(user)
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as cl:
        sess = (await cl.get(f"https://{JMAP_PUBLIC_HOST}/jmap/session", headers=s["headers"])).json()
    url = (_rehost(sess.get("eventSourceUrl", "")).replace("{types}", "Email,Mailbox,EmailSubmission")
           .replace("{closeafter}", "no").replace("{ping}", "25"))

    async def gen():
        yield b"event: ready\ndata: {}\n\n"
        while True:
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(20, read=90), follow_redirects=True) as cl:
                    async with cl.stream("GET", url, headers={"Authorization": s["headers"]["Authorization"],
                                                              "Accept": "text/event-stream"}) as r:
                        if r.status_code != 200:
                            yield f"event: error\ndata: {json.dumps({'status': r.status_code})}\n\n".encode()
                            await asyncio.sleep(15)
                            continue
                        async for line in r.aiter_lines():
                            if await request.is_disconnected():
                                return
                            yield (line + "\n").encode()
            except (httpx.HTTPError, asyncio.CancelledError):
                if await request.is_disconnected():
                    return
                yield b"event: reconnect\ndata: {}\n\n"
                await asyncio.sleep(5)

    return _SR(gen(), media_type="text/event-stream",
               headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Snooze ────────────────────────────────────────────────────────────────
#
# The mail gets `$snoozed`, moves to the folder "Geplant" (role snoozed, created
# if missing) and is stored with its wake-up time in `claraos_post_snooze`. A
# background loop (every 60 s, see `snooze_loop`) moves due mails back to their
# original folder, removes the keyword and marks them unread — so they show up
# at the top of the inbox again, like Outlook's "remind me again".

_snooze_table_ready = False


async def _ensure_snooze_table() -> None:
    global _snooze_table_ready
    if _snooze_table_ready:
        return
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_post_snooze (
                username     TEXT NOT NULL,
                email_id     TEXT NOT NULL,
                wake_at      TIMESTAMPTZ NOT NULL,
                mailbox_from TEXT,
                created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (username, email_id)
            )
        """)
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_post_snooze_wake ON claraos_post_snooze (wake_at)")
    _snooze_table_ready = True


async def _snoozed_mailbox(user: str) -> str:
    s = await _jmap_session(user)
    r = await _jmap(user, [["Mailbox/get", {"accountId": s["account"], "properties": ["id", "role", "name"]}, "m"]])
    boxes = _by_tag(r, "m").get("list") or []
    hit = next((m for m in boxes if m.get("role") == "snoozed" or (m.get("name") or "").lower() in ("geplant", "snoozed")), None)
    if hit:
        return hit["id"]
    c = await _jmap(user, [["Mailbox/set", {"accountId": s["account"], "create": {"z": {"name": "Geplant", "role": "snoozed"}}}, "c"]])
    d = _by_tag(c, "c")
    created = (d.get("created") or {}).get("z")
    if not created:
        # Role may not be allowed → without role
        c = await _jmap(user, [["Mailbox/set", {"accountId": s["account"], "create": {"z": {"name": "Geplant"}}}, "c2"]])
        created = (_by_tag(c, "c2").get("created") or {}).get("z")
    if not created:
        raise HTTPException(status_code=502, detail="Ordner „Geplant“ konnte nicht angelegt werden")
    return created["id"]


class SnoozeIn(BaseModel):
    ids: list[str]
    until: str                          # ISO (local time) or shorthand: later|tomorrow|weekend|nextweek


def _snooze_until(raw: str) -> datetime:
    now = datetime.now(LOCAL_TZ)
    k = (raw or "").strip().lower()
    if k == "later":
        t = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=3)
        return t
    if k == "evening":
        t = now.replace(hour=18, minute=0, second=0, microsecond=0)
        return t if t > now else t + timedelta(days=1)
    if k == "tomorrow":
        return (now + timedelta(days=1)).replace(hour=9, minute=0, second=0, microsecond=0)
    if k == "weekend":
        days = (5 - now.weekday()) % 7 or 7
        return (now + timedelta(days=days)).replace(hour=9, minute=0, second=0, microsecond=0)
    if k == "nextweek":
        days = (7 - now.weekday()) % 7 or 7
        return (now + timedelta(days=days)).replace(hour=9, minute=0, second=0, microsecond=0)
    try:
        d = datetime.fromisoformat(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="Weckzeit unlesbar")
    if d.tzinfo is None:
        d = d.replace(tzinfo=LOCAL_TZ)
    if d <= now:
        raise HTTPException(status_code=400, detail="Weckzeit liegt in der Vergangenheit")
    return d


@router.post("/snooze")
async def post_snooze(body: SnoozeIn, request: Request):
    user = require_caller(request)
    if not body.ids:
        raise HTTPException(status_code=400, detail="ids fehlt")
    await _ensure_snooze_table()
    s = await _jmap_session(user)
    wake = _snooze_until(body.until)
    target = await _snoozed_mailbox(user)
    r = await _jmap(user, [["Email/get", {"accountId": s["account"], "ids": body.ids, "properties": ["id", "mailboxIds"]}, "g"]])
    origin = {e["id"]: next(iter((e.get("mailboxIds") or {}).keys()), None) for e in _by_tag(r, "g").get("list") or []}
    upd = {i: {"mailboxIds": {target: True}, "keywords/$snoozed": True} for i in body.ids}
    r2 = await _jmap(user, [["Email/set", {"accountId": s["account"], "update": upd}, "s"]])
    done = list((_by_tag(r2, "s").get("updated") or {}).keys())
    async with user_tx(user) as conn:
        for i in done:
            await conn.execute("""
                INSERT INTO claraos_post_snooze (username, email_id, wake_at, mailbox_from) VALUES ($1, $2, $3, $4)
                ON CONFLICT (username, email_id) DO UPDATE SET wake_at = EXCLUDED.wake_at, mailbox_from = EXCLUDED.mailbox_from
            """, user, i, wake, origin.get(i))
    return {"ok": True, "snoozed": done, "wake_at": wake.isoformat(),
            "message": f"{len(done)} Mail(s) schlummern bis {wake.strftime('%a %d.%m. %H:%M')}"}


async def _wake(user: str, email_ids: list[str]) -> int:
    await _ensure_snooze_table()
    async with user_tx(user) as conn:
        rows = await conn.fetch("SELECT email_id, mailbox_from FROM claraos_post_snooze WHERE username = $1 AND email_id = ANY($2::text[])", user, email_ids)
    if not rows:
        return 0
    s = await _jmap_session(user)
    roles = await _roles(user)
    upd = {}
    for row in rows:
        dest = row["mailbox_from"] or roles.get("inbox")
        if dest:
            upd[row["email_id"]] = {"mailboxIds": {dest: True}, "keywords/$snoozed": None, "keywords/$seen": None}
    if upd:
        await _jmap(user, [["Email/set", {"accountId": s["account"], "update": upd}, "s"]])
    async with user_tx(user) as conn:
        await conn.execute("DELETE FROM claraos_post_snooze WHERE username = $1 AND email_id = ANY($2::text[])", user, email_ids)
    return len(upd)


@router.post("/unsnooze")
async def post_unsnooze(body: PostSet, request: Request):
    user = require_caller(request)
    n = await _wake(user, body.ids)
    return {"ok": True, "woken": n, "message": f"{n} Mail(s) zurück im Posteingang"}


@router.get("/snoozed")
async def post_snoozed(request: Request):
    user = require_caller(request)
    await _ensure_snooze_table()
    async with user_tx(user) as conn:
        rows = await conn.fetch("SELECT email_id, wake_at FROM claraos_post_snooze WHERE username = $1", user)
    return {"snoozed": {r["email_id"]: r["wake_at"].astimezone(LOCAL_TZ).isoformat() for r in rows}}


async def snooze_loop() -> None:
    """Background: wake due snoozed mails (started from the main.py lifespan)."""
    while True:
        await asyncio.sleep(60)
        try:
            await _ensure_snooze_table()
            # Service path: finds due mails of ALL users, then wakes each user's
            # mails inside that user's own RLS transaction (_wake).
            pool = await get_pool()
            async with pool.acquire() as conn:
                rows = await conn.fetch("SELECT username, email_id FROM claraos_post_snooze WHERE wake_at <= NOW()")
            by_user: dict[str, list[str]] = {}
            for r in rows:
                by_user.setdefault(r["username"], []).append(r["email_id"])
            for user, ids in by_user.items():
                try:
                    n = await _wake(user, ids)
                    logger.info("[post-snooze] %s: %d Mail(s) geweckt", user, n)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("[post-snooze] %s: %s", user, exc)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[post-snooze] Lauf fehlgeschlagen: %s", exc)
