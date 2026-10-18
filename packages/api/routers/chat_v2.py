"""Clara Chat v2 — proxy to Open WebUI for unified clara-chat surfaces.

Open WebUI is the source of truth for chat persistence (folders, chats, files).
This proxy:
  * forwards REST calls to Open WebUI's internal API with per-user auth
  * carries `app_id` / `object_uri` / `surface` as `meta` JSON on each chat
  * streams chat completions through to WebUI (which fans out to LiteLLM)

Auth-translation strategy (V1 → V2):
  * V1: a single shared Open-WebUI admin API-key (`OPENWEBUI_API_KEY` env) is
        used for all calls. All chats end up owned by that admin user. This
        is enough to validate the architecture for the single-admin case and
        unblocks frontend work.
  * V2: per-ClaraOS-user JWT minting using `WEBUI_SECRET_KEY` (HS256) +
        webui_user_id lookup via admin `/api/v1/users` endpoint.
        Hook point: `_get_webui_token(user)` below — replace V1 fallback.
"""
from __future__ import annotations

from domains_generated import BASE_DOMAIN  # cell: CLARAOS_BASE_DOMAIN
import betriebsprofil
from betriebsprofil import heim_default  # external cell: no silent home-server fallback
from services import brain_turns, chat_lauf, identitaet
import asyncio
import hashlib
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Request, UploadFile, File, Form
from fastapi.responses import StreamingResponse, JSONResponse, Response

from auth import GROUP_ROLE_MAP, get_current_user, is_service_call
from .marker_context import apply_marker_to_messages, enrich_marker_with_vision, bild_beschreiben

# Optional context lines for installation-specific apps (chat_kontext_heim.py;
# without it only the product's own apps get context).
try:
    import chat_kontext_heim as _heim_kontext
except ImportError:
    _heim_kontext = None
_heim_app_kontext = getattr(_heim_kontext, "app_kontext", None)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/claraos/chat/v2", tags=["chat-v2"])

# ── Active-stream registry (active-agents panel) ─────────────────────────────
# In-memory list of currently-streaming completions.
# Each entry: {id, user, app_id, object_uri, surface, started_at, last_delta_at}
_active_streams: dict[str, dict] = {}
_streams_lock = asyncio.Lock()


async def _stream_register(stream_id: str, user: dict, meta: dict) -> None:
    async with _streams_lock:
        _active_streams[stream_id] = {
            "id": stream_id,
            "user": user.get("username") or "dev",
            "app_id": meta.get("app_id"),
            "object_uri": meta.get("object_uri"),
            "surface": meta.get("surface"),
            "wrapp_instance_id": meta.get("wrapp_instance_id"),
            "started_at": time.time(),
            "last_delta_at": time.time(),
        }


async def _stream_touch(stream_id: str) -> None:
    async with _streams_lock:
        info = _active_streams.get(stream_id)
        if info:
            info["last_delta_at"] = time.time()


async def _stream_unregister(stream_id: str) -> None:
    async with _streams_lock:
        _active_streams.pop(stream_id, None)

# ── Data class ──────────────────────────────────────────────────────────────
# Warning: declared, but not enforceable here. This path does not pick a model:
# it forwards the request to Open WebUI, and the decision is made *there*. A
# check at this point would be a promise about something another machine
# does — so it would be no check at all.
#
# The declaration stays anyway: it marks a place where the data class still
# has to arrive once Open WebUI accepts it. Without it the gap would be
# invisible, and invisible gaps do not get closed.
DATENKLASSE = "oeffentlich"
DATENKLASSE_ERZWUNGEN = False

OPENWEBUI_URL = heim_default("OPENWEBUI_URL")
# TTS goes DIRECTLY to Speaches (voice service), not through WebUI: WebUI transcodes
# to MP3 and drops sample_rate — Speaches then labels Piper 16 kHz audio as
# 24 kHz WITHOUT resampling → 1.5x too fast, chipmunk voice.
SPEACHES_URL = heim_default("SPEACHES_URL")
# Native rate of the configured Piper model (*-low voices = 16000). Adjust when
# switching models (e.g. *-medium = 22050).
TTS_SAMPLE_RATE = int(os.environ.get("TTS_SAMPLE_RATE", "16000"))
# Default voice = Supertonic (separate voice service, returns 24 kHz WAV).
# Speaches/Piper remains the fallback chain.
SUPERTONIC_URL = heim_default("SUPERTONIC_URL")
TTS_DEFAULT_MODEL = os.environ.get("CLARAOS_TTS_MODEL", "supertonic-3")
TTS_DEFAULT_VOICE = os.environ.get("CLARAOS_TTS_VOICE", "F1")
# LiveKit voice — tokens are minted by the shim of the voice service (the LiveKit
# keys live there, so claraos-api needs no additional secrets).
LIVEKIT_SHIM_URL = heim_default("LIVEKIT_SHIM_URL")
VOICE_WS_URL = os.environ.get("CLARAOS_VOICE_WS_URL", f"wss://voice.{BASE_DOMAIN}")

# Test-mode: deterministic echo bypass for the E2E suite.
# Activated EITHER by env CLARA_TEST_MODE=true (whole instance) OR by request
# header `X-Claraos-Test-Mode: true` (per-call). The header path is intra-net
# only — claraos-api isn't externally exposed, so the header can't be forged
# by an outside caller without first reaching the docker network.
_TEST_MODE_ENV = os.environ.get("CLARA_TEST_MODE", "").lower() == "true"
_TEST_MODE_USERS = {
    u.strip().lower()
    for u in os.environ.get("CLARA_TEST_MODE_USERS", "playwright-test").split(",")
    if u.strip()
}


def _test_mode_active(request: Request, user: dict | None = None) -> bool:
    """Test-mode is on if EITHER:
      - CLARA_TEST_MODE env=true (dev-instance-wide), OR
      - X-Claraos-Test-Mode header=true AND request user is in
        CLARA_TEST_MODE_USERS (defense in depth — production users can't
        flip test-mode by injecting a header).

    Default user-allow-list = `playwright-test`; override with the env var.
    """
    if _TEST_MODE_ENV:
        return True
    if (request.headers.get("x-claraos-test-mode") or "").lower() != "true":
        return False
    user_obj = user or {}
    username = (user_obj.get("username") or "").lower()
    return username in _TEST_MODE_USERS
OPENWEBUI_API_KEY = os.environ.get("OPENWEBUI_API_KEY", "")  # admin/service token (V1)


# ---------------------------------------------------------------------------
# The trusted context block
# ---------------------------------------------------------------------------
# Agents read identity (`chat_user:`) and run flags (`messlauf:`) from the
# "[ClaraOS context]" block. Only the block this proxy writes for the current
# turn may be trusted, so any marker a user typed — or an old block replayed
# from the history — is defused before the real one is added.
_CTX_MARKER_RE = re.compile(r"\[\s*claraos\s+context\s*\]", re.IGNORECASE)
_CTX_MARKER_DEFUSED = "[context, user text]"
_IDENTITY_KEY_RE = re.compile(
    r"\b(chat_user(?:_sig|_ts)?|chat_zug|chat_turn|chat_session|messlauf)(\s*):", re.IGNORECASE)
_APP_ID_OK = re.compile(r"[A-Za-z0-9._-]{1,64}")
# Apps with deep-link patterns (app_url_patterns), plus the installation's own.
_DEEPLINK_APPS = frozenset({"paperless"}) | getattr(_heim_kontext, "DEEPLINK_APPS", frozenset())
_DEEPLINK_KNOWN = getattr(_heim_kontext, "DEEPLINK_BEKANNT", "") or "paperless(document/search)."


def _defuse_text(text: str) -> str:
    return _CTX_MARKER_RE.sub(_CTX_MARKER_DEFUSED, text)


def neutralize_context_markers(messages: list) -> int:
    """Defuse every "[ClaraOS context]" marker in client-supplied messages (all roles).

    Returns how many messages were changed.
    """
    changed = 0
    for m in messages:
        if not isinstance(m, dict):
            continue
        content = m.get("content")
        if isinstance(content, str):
            new = _defuse_text(content)
            if new != content:
                m["content"] = new
                changed += 1
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and isinstance(part.get("text"), str):
                    new = _defuse_text(part["text"])
                    if new != part["text"]:
                        part["text"] = new
                        changed += 1
    return changed


def _defuse_part(part: str) -> str:
    """A context part that may contain client text: no marker, no identity/flag
    keys, no blank line (a blank line ends the block for its readers)."""
    out = _defuse_text(part)
    out = _IDENTITY_KEY_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}=", out)
    return re.sub(r"\n\s*\n", "\n", out)


# ---------------------------------------------------------------------------
# Auth translation (ClaraOS → WebUI)
# ---------------------------------------------------------------------------

_WEBUI_ID_TTL = 300.0
_webui_ids: dict[str, tuple[float, str]] = {}

_AUTHENTIK_URL = heim_default("AUTHENTIK_URL", key="AUTHENTIK_URL@admin_view")
_directory: dict[str, tuple[float, str, list[str]]] = {}


async def _with_directory_identity(user: dict) -> dict:
    """Fill in email and groups of a user that a machine caller named by username only.

    Caddy forwards email and groups for a browser user. A service caller (voice
    agent, assistants) sends just `X-Authentik-Username`, so the user arrived here
    without email and as role "guest" — the Open WebUI lookup below found no
    account and every such chat turn failed with 503. The user is looked up in
    Authentik by exact username; their real role follows from their real groups,
    exactly as for the browser. Nothing is granted beyond what that user has.
    Without a directory (cell, missing token) the user is returned unchanged.
    """
    if (user.get("email") or "").strip():
        return user
    name = (user.get("username") or "").strip()
    token = os.environ.get("AUTHENTIK_API_TOKEN", "").strip()
    if not name or not token or not _AUTHENTIK_URL:
        return user
    now = time.time()
    hit = _directory.get(name)
    if hit and hit[0] > now:
        mail, groups = hit[1], hit[2]
    else:
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                r = await c.get(f"{_AUTHENTIK_URL.rstrip('/')}/api/v3/core/users/",
                                params={"username": name, "is_active": "true"},
                                headers={"Authorization": f"Bearer {token}"})
        except httpx.HTTPError as exc:
            logger.warning("directory lookup for %s failed: %s", name, type(exc).__name__)
            return user
        if r.status_code != 200:
            logger.warning("directory lookup for %s failed: HTTP %s", name, r.status_code)
            return user
        exact = [u for u in (r.json().get("results") or []) if u.get("username") == name]
        if len(exact) != 1:
            mail, groups = "", []
        else:
            mail = (exact[0].get("email") or "").strip()
            groups = [g.get("name", "") for g in (exact[0].get("groups_obj") or [])
                      if isinstance(g, dict)]
        _directory[name] = (now + _WEBUI_ID_TTL, mail, groups)
    if not mail:
        return user
    role = next((r for g, r in GROUP_ROLE_MAP.items() if g in groups), "guest")
    return {**user, "email": mail, "groups": groups, "role": role}


async def _webui_user_id(user: dict) -> str:
    """Open WebUI account ID of the user — or "" if they have none there.

    Warning: matching is by email, because Open WebUI stores no OIDC identifier
    here (`oauth_sub` is empty for all accounts). For Immich this exact approach
    was a trap — there an `oauthId` existed. Here there is nothing better, hence
    email, and hence this warning: if the addresses do not match, the lookup
    finds no account and the history stays closed (fail-closed) — it NEVER
    shows someone else's.
    """
    mail = (user.get("email") or "").strip().lower()
    if not mail:
        return ""
    now = time.time()
    hit = _webui_ids.get(mail)
    if hit and hit[0] > now:
        return hit[1]
    if not OPENWEBUI_API_KEY:
        return ""
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(f"{OPENWEBUI_URL.rstrip('/')}/api/v1/users/",
                        headers={"Authorization": f"Bearer {OPENWEBUI_API_KEY}"})
    if r.status_code != 200:
        logger.warning("WebUI-Nutzerliste nicht lesbar: %s", r.status_code)
        return ""
    d = r.json()
    konten = d.get("users", d) if isinstance(d, dict) else d
    treffer = next((k for k in konten
                    if (k.get("email") or "").strip().lower() == mail), None)
    uid = str(treffer["id"]) if treffer else ""
    _webui_ids[mail] = (now + _WEBUI_ID_TTL, uid)
    return uid


async def _provision_webui_user(user: dict) -> str:
    """Create the user's own Open WebUI account (role "user") and return its id.

    The password is random and stored nowhere: the user never signs in there
    directly, only through this API's short-lived token (same as the cell's
    provision_owui.py). Returns "" if it cannot be done.
    """
    mail = (user.get("email") or "").strip().lower()
    if not mail or not OPENWEBUI_API_KEY:
        return ""
    import secrets as _secrets
    name = (user.get("name") or user.get("username") or mail).strip()[:80]
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(f"{OPENWEBUI_URL.rstrip('/')}/api/v1/auths/add",
                             headers={"Authorization": f"Bearer {OPENWEBUI_API_KEY}"},
                             json={"name": name, "email": mail,
                                   "password": _secrets.token_urlsafe(24), "role": "user"})
    except httpx.HTTPError as exc:
        logger.warning("Open WebUI account for %s not created: %s", user.get("username"), exc)
        return ""
    if r.status_code != 200:
        # Never log the response body: it may echo the request (password).
        logger.warning("Open WebUI account for %s not created (HTTP %s)",
                       user.get("username"), r.status_code)
        return ""
    _webui_ids.pop(mail, None)
    logger.info("Open WebUI account created for %s", user.get("username"))
    return await _webui_user_id(user)


async def _get_webui_token(user: dict, *, strict: bool = True) -> str:
    """Bearer token for the Open WebUI API — per user.

    `strict=True` (history, folders): without an own account there is **nothing**.
    `strict=False` (chatting, files, speech): no stored user data is read there —
    the messages are in the request. If the user has no own account, the
    service identity may step in.

    Why this distinction exists: a blanket block here once also hit
    `/completions`, which calls this function directly (not via
    `_webui_request`). Non-admin users could not talk to Clara at all, while the
    error message claimed chatting still worked.
    Lesson: whoever adds a block to a helper function must count ALL call
    sites — not just the one they have in mind.

    The fail-closed behaviour exists because a SHARED admin token used to be
    returned, so everyone saw the history of the same account. The actual fix
    is one JWT per user, signed with `WEBUI_SECRET_KEY` (= `SESSION_SECRET` in
    Open WebUI, see its `utils/auth.py`).

    Important: the key is read AT RUNTIME, not as a module constant: the
    secret bootstrap runs in the lifespan, i.e. AFTER the routers are
    imported. A constant would have stayed empty forever.

    Admins deliberately keep the admin token: that IS their own account (where
    their chats live). An email match would have sent them to a second, empty
    SSO account and made the history appear deleted.
    """
    user = await _with_directory_identity(user or {})
    if user.get("role") == "admin":
        if not OPENWEBUI_API_KEY:
            raise HTTPException(status_code=503,
                                detail="OPENWEBUI_API_KEY not configured for chat v2 proxy")
        return OPENWEBUI_API_KEY

    # No silent fallback to the admin account any more (`strict` only changes the
    # message): a non-admin without an own account used to chat, upload and
    # transcribe AS the admin — with the admin's models, tools and chat store.
    # Instead the account is created on first use (same as
    # deploy/cell/provision_owui.py), and if that is impossible the user gets a
    # clear message.
    secret = os.environ.get("WEBUI_SECRET_KEY", "")
    if not secret:
        raise HTTPException(
            status_code=503,
            detail="Der Chat ist gerade nicht verfügbar (Konfiguration unvollständig).")

    uid = await _webui_user_id(user)
    if not uid:
        uid = await _provision_webui_user(user)
    if not uid:
        raise HTTPException(
            status_code=503,
            detail=("Für dich ist noch kein Chat-Konto eingerichtet, und es ließ sich nicht "
                    "automatisch anlegen. Bitte melde dich einmal in der Chat-App an "
                    "oder bitte den Admin darum." if not strict else
                    "Für dich gibt es noch keinen gespeicherten Chatverlauf — "
                    "öffne einmal die Chat-App, danach steht er zur Verfügung."))

    import jwt  # local: only this path needs the library
    jetzt = datetime.now(timezone.utc)
    return jwt.encode(
        {"id": uid, "jti": str(uuid.uuid4()), "iat": jetzt,
         "exp": jetzt + timedelta(minutes=15)},
        secret, algorithm="HS256")


async def _webui_request(
    user: dict,
    method: str,
    path: str,
    *,
    params: Optional[dict] = None,
    json_body: Optional[dict] = None,
    timeout: float = 30.0,
) -> httpx.Response:
    token = await _get_webui_token(user)
    url = f"{OPENWEBUI_URL.rstrip('/')}{path}"
    async with httpx.AsyncClient(timeout=timeout) as client:
        return await client.request(
            method,
            url,
            params=params,
            json=json_body,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            },
        )


def _passthrough(resp: httpx.Response) -> JSONResponse:
    try:
        body = resp.json()
    except Exception:
        body = {"raw": resp.text}
    return JSONResponse(content=body, status_code=resp.status_code)


# ---------------------------------------------------------------------------
# Folders (nested via parent_id, native Open WebUI support since v0.4.5)
# ---------------------------------------------------------------------------

@router.get("/folders")
async def list_folders(request: Request) -> JSONResponse:
    """List folders for the current user (nested via parent_id)."""
    user = get_current_user(request)
    resp = await _webui_request(user, "GET", "/api/v1/folders/")
    return _passthrough(resp)


@router.post("/folders")
async def create_folder(request: Request) -> JSONResponse:
    """Create a (sub-)folder. Body: { name, parent_id?: string }.

    WebUI's /api/v1/folders/ endpoint silently drops parent_id from the
    create payload — we set it via the dedicated /update/parent route after
    creation.
    """
    user = get_current_user(request)
    body = await request.json()
    name = body.get("name")
    if not name:
        raise HTTPException(400, "folder name required")
    parent_id = body.get("parent_id")
    resp = await _webui_request(user, "POST", "/api/v1/folders/", json_body={"name": name})
    # Idempotency: when the same (name, parent_id) is requested multiple times
    # in quick succession (multiple Clara surfaces mounting in parallel), WebUI
    # returns 400 "Folder already exists". Return the existing folder so the
    # client can proceed. We only match exact (name + parent) — orphans at a
    # different parent are NOT silently substituted (the frontend handles the
    # global-name-uniqueness constraint via name-only lookup before create).
    if resp.status_code == 400 and "already exists" in (resp.text or "").lower():
        listing = await _webui_request(user, "GET", "/api/v1/folders/")
        if listing.status_code == 200 and isinstance(listing.json(), list):
            for f in listing.json():
                if (f.get("name") == name
                        and (f.get("parent_id") or None) == (parent_id or None)):
                    return JSONResponse(content=f)
        return _passthrough(resp)
    if resp.status_code != 200:
        return _passthrough(resp)
    created = resp.json()
    # WebUI returns the new folder id under different keys depending on
    # version — extract from the dict.
    new_id = None
    if isinstance(created, dict):
        new_id = created.get("id")
        if not new_id:
            # Some versions return list — pick the latest
            for f in created.values() if isinstance(created, dict) else []:
                if isinstance(f, dict) and f.get("name") == name:
                    new_id = f.get("id")
                    break
    if not new_id:
        # Fallback: look up freshly via the listing
        listing = await _webui_request(user, "GET", "/api/v1/folders/")
        if listing.status_code == 200 and isinstance(listing.json(), list):
            for f in listing.json():
                if f.get("name") == name and not f.get("parent_id"):
                    new_id = f.get("id")
                    if not parent_id:
                        break
    if new_id and parent_id:
        await _webui_request(
            user, "POST", f"/api/v1/folders/{new_id}/update/parent",
            json_body={"parent_id": parent_id},
        )
        # Re-read so the response reflects the new parent
        re_resp = await _webui_request(user, "GET", f"/api/v1/folders/{new_id}")
        if re_resp.status_code == 200:
            return JSONResponse(content=re_resp.json())
    return _passthrough(resp)


@router.patch("/folders/{folder_id}")
async def update_folder(folder_id: str, request: Request) -> JSONResponse:
    """Rename / re-parent a folder. Body: { name?, parent_id? }."""
    user = get_current_user(request)
    body = await request.json()
    # Open WebUI uses separate endpoints for /update/name + /update/parent — we
    # call whichever fields the client requested.
    out: dict = {}
    if "name" in body:
        r = await _webui_request(
            user, "POST", f"/api/v1/folders/{folder_id}/update",
            json_body={"name": body["name"]},
        )
        out["name"] = r.status_code
    if "parent_id" in body:
        r = await _webui_request(
            user, "POST", f"/api/v1/folders/{folder_id}/update/parent",
            json_body={"parent_id": body["parent_id"]},
        )
        out["parent_id"] = r.status_code
    return JSONResponse(content=out)


@router.delete("/folders/{folder_id}")
async def delete_folder(folder_id: str, request: Request) -> JSONResponse:
    user = get_current_user(request)
    resp = await _webui_request(user, "DELETE", f"/api/v1/folders/{folder_id}")
    return _passthrough(resp)


# ── Auto-folder cleanup ─────────────────────────────────────────────────────

# Folder names the auto-organizer creates. Only these are eligible for
# automatic cleanup (user-named folders are never touched).
_AUTO_FOLDER_NAMES = {"🤖 App Chats", "⚡ Quick Chats"}


async def _scan_empty_auto_folders(user: dict) -> list[dict]:
    """Return the list of auto-folders (and their auto-children) that are
    empty AND have no chats inside. We touch only folders whose name matches
    `_AUTO_FOLDER_NAMES` *or* are descendants of one. User-created folders are
    never returned even if empty."""
    folders_resp = await _webui_request(user, "GET", "/api/v1/folders/")
    if folders_resp.status_code != 200:
        return []
    folders = folders_resp.json() if isinstance(folders_resp.json(), list) else []

    chats_resp = await _webui_request(user, "GET", "/api/v1/chats/", params={"page": 1})
    if chats_resp.status_code != 200:
        return []
    chats = chats_resp.json() if isinstance(chats_resp.json(), list) else chats_resp.json().get("chats", [])

    by_id = {f["id"]: f for f in folders}
    children: dict[str | None, list[dict]] = {}
    for f in folders:
        children.setdefault(f.get("parent_id"), []).append(f)

    # Mark every folder reachable from an auto-root
    auto_descendants: set[str] = set()
    queue = [f for f in folders if not f.get("parent_id") and f.get("name") in _AUTO_FOLDER_NAMES]
    while queue:
        f = queue.pop()
        auto_descendants.add(f["id"])
        queue.extend(children.get(f["id"], []))

    # Find chats per folder (non-recursive: WebUI groups chats by exact folder_id)
    chat_count: dict[str, int] = {}
    for c in chats:
        fid = c.get("folder_id")
        if fid:
            chat_count[fid] = chat_count.get(fid, 0) + 1

    # An auto-folder is empty if it has no chats AND every descendant is empty
    # too. Memoise per-fid (no shared cycle-set across calls — the previous
    # implementation re-used a single `visited` set across is_empty() top-
    # level invocations and falsely marked already-walked descendants as
    # non-empty when checked at the top level afterward).
    is_empty_cache: dict[str, bool] = {}

    def is_empty(fid: str) -> bool:
        if fid in is_empty_cache:
            return is_empty_cache[fid]
        if chat_count.get(fid, 0) > 0:
            is_empty_cache[fid] = False
            return False
        for child in children.get(fid, []):
            if not is_empty(child["id"]):
                is_empty_cache[fid] = False
                return False
        is_empty_cache[fid] = True
        return True

    empties: list[dict] = []
    for fid in auto_descendants:
        if is_empty(fid):
            f = by_id[fid]
            empties.append({
                "id": fid,
                "name": f.get("name"),
                "parent_id": f.get("parent_id"),
            })
    return empties


@router.get("/folders/cleanup-candidates")
async def cleanup_candidates(request: Request) -> JSONResponse:
    """Preview which auto-folders would be removed by /folders/cleanup.

    Only folders descending from `🤖 App Chats` or `⚡ Quick Chats` and
    containing zero chats (recursively) are listed. User-created folders are
    never included.
    """
    user = get_current_user(request)
    return JSONResponse(content={"candidates": await _scan_empty_auto_folders(user)})


@router.post("/folders/cleanup")
async def cleanup_folders(request: Request) -> JSONResponse:
    """Delete every empty auto-folder (cascades depth-first)."""
    user = get_current_user(request)
    candidates = await _scan_empty_auto_folders(user)
    # Delete deepest-first so parents become empty as we cascade.
    candidates.sort(key=lambda c: -(c["name"] or "").count("/"))
    deleted: list[str] = []
    failed: list[dict] = []
    for c in candidates:
        resp = await _webui_request(user, "DELETE", f"/api/v1/folders/{c['id']}")
        if 200 <= resp.status_code < 300:
            deleted.append(c["id"])
        else:
            failed.append({"id": c["id"], "name": c["name"], "status": resp.status_code})
    return JSONResponse(content={"deleted": deleted, "failed": failed, "count": len(deleted)})


# ---------------------------------------------------------------------------
# Chats (with meta JSON for app_id / object_uri / surface)
# ---------------------------------------------------------------------------

# ── Suggestions for the empty state ──────────────────────────────────────────
# Gemini/ChatGPT show what you can ask in an empty chat. The "preferred
# actions" are tool hints for Clara, not sentences for humans — hence a
# curated list per app here. `sofort=True` means tapping sends immediately;
# otherwise the text lands in the input as a draft (the sentence is incomplete).
_VORSCHLAEGE: dict[str, list[dict]] = {
    "planner": [
        {"label": "Was ist heute überfällig?", "prompt": "Was ist heute überfällig? Fasse kurz zusammen.", "sofort": True},
        {"label": "Aufgabe anlegen", "prompt": "Lege eine Aufgabe an: ", "sofort": False},
        {"label": "Woche zusammenfassen", "prompt": "Fasse meine Woche zusammen: Termine und offene Aufgaben.", "sofort": True},
        {"label": "Freien Termin finden", "prompt": "Finde mir diese Woche einen freien Termin für ", "sofort": False},
    ],
    "files": [
        {"label": "Was liegt hier?", "prompt": "Was liegt in diesem Ordner? Gib mir einen kurzen Überblick.", "sofort": True},
        {"label": "Datei finden", "prompt": "Finde die Datei ", "sofort": False},
        {"label": "Zusammenfassen", "prompt": "Fasse die ausgewählte Datei zusammen.", "sofort": True},
    ],
    "knowledge": [
        {"label": "Was weiß ich dazu?", "prompt": "Was steht in meiner Wissens-App zu ", "sofort": False},
        {"label": "Notiz anlegen", "prompt": "Lege eine Notiz an: ", "sofort": False},
        {"label": "Sammlung zusammenfassen", "prompt": "Fasse die aktuelle Sammlung zusammen.", "sofort": True},
    ],
    "kontakte": [
        {"label": "Kontakt suchen", "prompt": "Suche den Kontakt ", "sofort": False},
        {"label": "Geburtstage", "prompt": "Wer hat in den nächsten 30 Tagen Geburtstag?", "sofort": True},
        {"label": "Kontakt anlegen", "prompt": "Lege einen Kontakt an: ", "sofort": False},
    ],
    "geraete": [
        {"label": "Was ist an?", "prompt": "Welche Geräte sind gerade eingeschaltet?", "sofort": True},
        {"label": "Licht", "prompt": "Schalte das Licht ", "sofort": False},
        {"label": "Verbrauch heute", "prompt": "Wie hoch war der Stromverbrauch heute?", "sofort": True},
    ],
    "kamera": [
        {"label": "Was ist das?", "prompt": "Was ist auf dem Bild zu sehen?", "sofort": True},
        {"label": "Beleg erfassen", "prompt": "Erfasse den Beleg auf dem Foto.", "sofort": True},
    ],
    "image-viewer": [
        {"label": "Bild beschreiben", "prompt": "Beschreibe das offene Bild.", "sofort": True},
        {"label": "Heller machen", "prompt": "Mach das Bild etwas heller.", "sofort": True},
        {"label": "Hintergrund entfernen", "prompt": "Entferne den Hintergrund.", "sofort": True},
    ],
    "pdf-viewer": [
        {"label": "Zusammenfassen", "prompt": "Fasse dieses Dokument zusammen.", "sofort": True},
        {"label": "Frage zum Dokument", "prompt": "Was sagt das Dokument zu ", "sofort": False},
    ],
    "teams-workspace": [
        {"label": "Wer ist da?", "prompt": "Wer aus dem Team ist gerade erreichbar?", "sofort": True},
        {"label": "Nachricht entwerfen", "prompt": "Entwirf eine Nachricht an ", "sofort": False},
    ],
    "shopping": [
        {"label": "Einkaufsliste", "prompt": "Was steht auf der Einkaufsliste?", "sofort": True},
        {"label": "Hinzufügen", "prompt": "Setze auf die Einkaufsliste: ", "sofort": False},
    ],
}
_VORSCHLAEGE_ALLGEMEIN: list[dict] = [
    {"label": "Was steht heute an?", "prompt": "Was steht heute an? Termine und Aufgaben.", "sofort": True},
    {"label": "Fotos finden", "prompt": "Suche Fotos von ", "sofort": False},
    {"label": "Dokument zusammenfassen", "prompt": "Fasse mir dieses Dokument zusammen: ", "sofort": False},
    {"label": "Etwas nachschlagen", "prompt": "Recherchiere für mich: ", "sofort": False},
]


@router.get("/vorschlaege")
async def vorschlaege(request: Request, app: str | None = None):
    """Suggestion chips for the empty chat, depending on the open app."""
    get_current_user(request)
    liste = _VORSCHLAEGE.get(app or "", None)
    return {"app": app, "vorschlaege": liste if liste is not None else _VORSCHLAEGE_ALLGEMEIN}


@router.get("/chats")
async def list_chats(
    request: Request,
    folder_id: Optional[str] = None,
    app_id: Optional[str] = None,
    object_uri: Optional[str] = None,
    include_folders: bool = False,
    limit: int = 50,
) -> JSONResponse:
    """List chats. If filters set, filter client-side over WebUI's listing.

    WebUI doesn't filter on `meta` natively, so for `app_id`/`object_uri` we
    fetch a page and filter here. Folder filter is native.

    WebUI's page listing EXCLUDES chats that live in folders — with
    `include_folders=1` we merge every folder's chats in (stamped with their
    folder_id) so the frontend can render ONE unified, date-grouped history.
    """
    user = get_current_user(request)
    if folder_id:
        resp = await _webui_request(user, "GET", f"/api/v1/chats/folder/{folder_id}")
    else:
        resp = await _webui_request(user, "GET", "/api/v1/chats/", params={"page": 1})
    if resp.status_code != 200:
        return _passthrough(resp)
    chats = resp.json() if isinstance(resp.json(), list) else resp.json().get("chats", [])

    if include_folders and not folder_id:
        seen = {c.get("id") for c in chats if isinstance(c, dict)}
        folders_resp = await _webui_request(user, "GET", "/api/v1/folders/")
        if folders_resp.status_code == 200 and isinstance(folders_resp.json(), list):
            for f in folders_resp.json():
                fid = f.get("id")
                if not fid:
                    continue
                fchats_resp = await _webui_request(
                    user, "GET", f"/api/v1/chats/folder/{fid}"
                )
                if fchats_resp.status_code != 200:
                    continue
                fchats = fchats_resp.json()
                if not isinstance(fchats, list):
                    continue
                for c in fchats:
                    if not isinstance(c, dict) or c.get("id") in seen:
                        continue
                    c.setdefault("folder_id", fid)
                    seen.add(c.get("id"))
                    chats.append(c)
        chats.sort(key=lambda c: c.get("updated_at") or 0, reverse=True)

    if app_id or object_uri:
        # WebUI's listings carry no meta → filter via tags instead (see
        # create_chat). Chats created before tagging stay invisible to the
        # filter — the unfiltered list still shows them.
        erlaubt: set[str] | None = None
        for _tag in _meta_tags({"app_id": app_id, "object_uri": object_uri}):
            try:
                tr = await _webui_request(user, "POST", "/api/v1/chats/tags", json_body={"name": _tag})
                ids = {c.get("id") for c in (tr.json() if tr.status_code == 200 and isinstance(tr.json(), list) else [])}
            except Exception:  # noqa: BLE001
                ids = set()
            erlaubt = ids if erlaubt is None else (erlaubt & ids)
        chats = [c for c in chats if c.get("id") in (erlaubt or set())]
        for c in chats:
            m = c.get("meta") if isinstance(c.get("meta"), dict) else {}
            if app_id:
                m["app_id"] = app_id
            if object_uri:
                m["object_uri"] = object_uri
            c["meta"] = m
    return JSONResponse(content=chats[:limit])


@router.get("/chats/{chat_id}")
async def get_chat(chat_id: str, request: Request) -> JSONResponse:
    user = get_current_user(request)
    resp = await _webui_request(user, "GET", f"/api/v1/chats/{chat_id}")
    return _passthrough(resp)


def _meta_tags(meta: dict) -> list[str]:
    """Tags that make an app/object binding queryable in Open WebUI."""
    out: list[str] = []
    app_id = meta.get("app_id")
    if isinstance(app_id, str) and re.fullmatch(r"[a-z0-9_\-]{1,40}", app_id):
        out.append(f"app:{app_id}")
    obj = meta.get("object_uri")
    if isinstance(obj, str) and obj:
        out.append("obj:" + hashlib.sha1(obj.encode()).hexdigest()[:12])
    return out


@router.post("/chats")
async def create_chat(request: Request) -> JSONResponse:
    """Create a new chat with ClaraOS app-context meta.

    Body: { title, folder_id?, app_id?, object_uri?, surface?, messages? }
    """
    user = get_current_user(request)
    body = await request.json()
    title = body.get("title") or "Neuer Chat"
    folder_id = body.get("folder_id")
    app_id = body.get("app_id")
    object_uri = body.get("object_uri")
    surface = body.get("surface", "full")
    messages = body.get("messages") or []

    meta = {"surface": surface}
    if app_id:
        meta["app_id"] = app_id
    if object_uri:
        meta["object_uri"] = object_uri

    payload = {
        "chat": {
            "title": title,
            "models": body.get("models") or [],
            "messages": messages,
            "history": {"messages": {}, "currentId": None},
        }
    }
    resp = await _webui_request(user, "POST", "/api/v1/chats/new", json_body=payload)
    if resp.status_code != 200:
        return _passthrough(resp)
    created = resp.json()
    chat_id = created.get("id")
    if chat_id and meta:
        # Open WebUI's list API returns NO meta (only id, title, updated_at) —
        # a meta-based app filter could never match, every app-filtered list
        # was empty. Tags are the only server-side queryable carrier:
        # app:<id>, obj:<hash>. Nice-to-have, never blocking.
        for _tag in _meta_tags(meta):
            try:
                await _webui_request(user, "POST", f"/api/v1/chats/{chat_id}/tags",
                                     json_body={"name": _tag})
            except Exception:  # noqa: BLE001
                logger.debug("chat tag %s failed", _tag)
        # Set meta via the generic chat-update endpoint
        await _webui_request(
            user, "POST", f"/api/v1/chats/{chat_id}",
            json_body={"chat": {"meta": meta}},
        )
    if chat_id and folder_id:
        # WebUI has a dedicated endpoint for folder assignment; the generic
        # chat-update payload silently drops folder_id otherwise.
        await _webui_request(
            user, "POST", f"/api/v1/chats/{chat_id}/folder",
            json_body={"folder_id": folder_id},
        )
    return JSONResponse(content=created)


@router.patch("/chats/{chat_id}")
async def update_chat(chat_id: str, request: Request) -> JSONResponse:
    """Update chat properties: `title` (rename) and/or `messages`.

    `messages`: quick/overlay chats used to persist only the first user
    message (POST /chats on creation) — replies and follow-ups lived only in
    frontend state. The client now PATCHes the full thread after each stream
    ends; stored as `chat.messages` (the same structure that
    GET /chats/{id} → loadChat reads back).
    """
    user = get_current_user(request)
    body = await request.json()
    chat_update: dict = {}
    title = (body.get("title") or "").strip()
    if title:
        chat_update["title"] = title
    messages = body.get("messages")
    if isinstance(messages, list):
        # Keep only the fields relevant for persistence (no activity blob).
        # files (small previews) and blocks (cards) are part of the history —
        # without them a reload showed only the bare final text.
        def _klein(v, limit):
            try:
                return v if len(json.dumps(v)) <= limit else None
            except Exception:  # noqa: BLE001
                return None
        chat_update["messages"] = [
            {"role": m.get("role"), "content": m.get("content"),
             "timestamp": m.get("timestamp"),
             **({"files": _klein(m["files"], 60_000)} if isinstance(m.get("files"), list) and _klein(m["files"], 60_000) else {}),
             **({"blocks": _klein(m["blocks"], 40_000)} if isinstance(m.get("blocks"), list) and _klein(m["blocks"], 40_000) else {}),
             **({"sources": _klein(m["sources"], 4_000)} if isinstance(m.get("sources"), list) and _klein(m["sources"], 4_000) else {}),
             **({"suggestions": _klein(m["suggestions"], 1_000)} if isinstance(m.get("suggestions"), list) and _klein(m["suggestions"], 1_000) else {})}
            for m in messages
            if isinstance(m, dict) and m.get("role") in ("user", "assistant", "system")
        ]
    if not chat_update:
        return JSONResponse(status_code=400, content={"detail": "title or messages required"})
    resp = await _webui_request(
        user, "POST", f"/api/v1/chats/{chat_id}",
        json_body={"chat": chat_update},
    )
    return _passthrough(resp)


@router.patch("/chats/{chat_id}/folder")
async def move_chat_to_folder(chat_id: str, request: Request) -> JSONResponse:
    """Move a chat to a different folder (or to root if folder_id is null)."""
    user = get_current_user(request)
    body = await request.json()
    folder_id = body.get("folder_id")  # None = move to root
    resp = await _webui_request(
        user, "POST", f"/api/v1/chats/{chat_id}/folder",
        json_body={"folder_id": folder_id},
    )
    return _passthrough(resp)


@router.delete("/chats/{chat_id}")
async def delete_chat(chat_id: str, request: Request) -> JSONResponse:
    user = get_current_user(request)
    resp = await _webui_request(user, "DELETE", f"/api/v1/chats/{chat_id}")
    return _passthrough(resp)


# ---------------------------------------------------------------------------
# Plan-mode response
# ---------------------------------------------------------------------------

@router.post("/plan-response")
async def plan_response(request: Request) -> JSONResponse:
    """User response to a plan card from the stream.

    Body:
        { "plan_id": str, "action": "approve"|"reject"|"edit",
          "edited_plan": str (only when action=edit) }

    Stores the response in Postgres (claraos_agent_responses, TTL 30s);
    clara-agent polls it via GET /agent-response/{plan_id} in its
    _plan_task wait loop. The frontend calls this when the
    stop/edit/run-now buttons are clicked.
    """
    user = get_current_user(request)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"error": "invalid_json"}, status_code=400)

    plan_id = str(body.get("plan_id") or "")
    action = str(body.get("action") or "")
    edited = str(body.get("edited_plan") or "")[:8000]
    if not plan_id or action not in ("approve", "reject", "edit"):
        return JSONResponse(
            content={"error": "missing_fields", "required": ["plan_id", "action"]},
            status_code=400,
        )

    # Build value: simple string protocol so clara-agent can parse it without JSON
    val = f"edit:{edited}" if action == "edit" and edited else action

    from services.agent_response_service import save_response
    try:
        outcome = await save_response(
            plan_id, "plan", val, user.get("username") or "dev", ttl_s=30
        )
    except Exception as e:
        logger.exception("plan-response db-write failed")
        return JSONResponse(content={"error": "store_failed", "detail": str(e)}, status_code=500)
    if outcome == "already_consumed":
        return JSONResponse(content={"error": "already_consumed", "plan_id": plan_id}, status_code=409)

    return JSONResponse(content={"ok": True, "plan_id": plan_id, "action": action})


@router.post("/question-response")
async def question_response(request: Request) -> JSONResponse:
    """User response to an ask_user_question from the stream.

    Body: { "question_id": str, "answer": str }
    Stores the response in Postgres (TTL 90s); clara-agent polls
    GET /agent-response/{question_id}.
    """
    user = get_current_user(request)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"error": "invalid_json"}, status_code=400)

    question_id = str(body.get("question_id") or "")
    # Form answers are JSON and longer than a label
    answer = str(body.get("answer") or "")[:2000]
    if not question_id or not answer:
        return JSONResponse(
            content={"error": "missing_fields", "required": ["question_id", "answer"]},
            status_code=400,
        )
    from services.agent_response_service import save_response
    try:
        outcome = await save_response(
            question_id, "question", answer, user.get("username") or "dev", ttl_s=90
        )
    except Exception as e:
        logger.exception("question-response db-write failed")
        return JSONResponse(content={"error": "store_failed", "detail": str(e)}, status_code=500)
    if outcome == "already_consumed":
        return JSONResponse(
            content={"error": "already_consumed", "question_id": question_id},
            status_code=409,
        )
    return JSONResponse(content={"ok": True, "question_id": question_id})


@router.get("/agent-response/{request_id}")
async def get_agent_response(request_id: str, request: Request) -> JSONResponse:
    """Poll endpoint for clara-agent (replaces the Redis rendezvous).

    Cluster-internal: requires X-Claraos-User/X-Authentik-Username like the
    confirm status poll. The response is single-use — the first successful
    fetch consumes it. Pending deliberately returns 200 (never 404), so a new
    agent talking to an old API simply keeps polling until its timeout.
    """
    from routers.clara_tools import _trusted_caller
    if not _trusted_caller(request):
        raise HTTPException(status_code=401, detail="trusted caller required")
    from services.agent_response_service import consume_response
    try:
        val = await consume_response(request_id)
    except Exception as e:
        logger.exception("agent-response db-read failed")
        return JSONResponse(content={"error": "store_failed", "detail": str(e)}, status_code=500)
    if val is None:
        return JSONResponse(content={"status": "pending"})
    return JSONResponse(content={"status": "ready", "value": val})


# ---------------------------------------------------------------------------
# Streaming completions (proxy to WebUI's chat/completions)
# ---------------------------------------------------------------------------

@router.post("/completions")
async def chat_completions(request: Request):
    """Stream chat completion through Open WebUI (which routes to LiteLLM).

    When CLARA_TEST_MODE is active (env or header) we short-circuit to a
    deterministic echo response — used by the Playwright E2E suite to
    decouple UI tests from LLM provider availability + rate limits.
    """
    user = get_current_user(request)
    body = await request.json()
    # The question as the client stored it — the proxy edits the messages below.
    frage_text = chat_lauf.last_user_text(body.get("messages"))

    # Forward the chat user so clara-agent can target its
    # claraos_action_* dispatches at the right WebSocket. WebUI / LiteLLM
    # pass the `user` body field through to the upstream model — clara-agent
    # reads it as `req.user`.
    chat_username = (user.get("username") or "").lower()
    if chat_username:
        body["user"] = chat_username

    # ── Marker injection + Vision pre-pass ──────────────────────────────
    # Apply BEFORE the test-mode bypass so the echo path also sees the
    # mutation (T1 backend roundtrip test verifies multipart wiring).
    # For image-bearing kinds, run a Gemini-Flash pre-pass first so even
    # text-only downstream models (clara-agent's flatten path) get a usable
    # description embedded into the marker text-block.
    _early_meta = body.get("meta") or {}
    _early_marker = _early_meta.get("marker")
    if isinstance(_early_marker, dict) and isinstance(body.get("messages"), list):
        try:
            # Test-mode skips pre-pass to keep T1 fast + deterministic
            _litellm_url = os.environ.get("LITELLM_BASE_URL", "")
            _litellm_key = os.environ.get("LITELLM_MASTER_KEY", "")
            if not _test_mode_active(request, user) and _litellm_url and _litellm_key:
                _early_marker = await enrich_marker_with_vision(
                    _early_marker,
                    litellm_url=_litellm_url,
                    litellm_key=_litellm_key,
                )
            apply_marker_to_messages(body["messages"], _early_marker)
        except Exception:  # noqa: BLE001
            logger.exception("marker injection failed (early path)")

    # ── Image attachments from the phone ─────────────────────────────────
    # Open WebUI drops image_url blocks from /api/chat/completions, and the
    # agent reads only text. So the same pattern as for the marker: Gemini
    # Flash describes each image, and the description is inserted as a text
    # block BEFORE the question in the last user message. The base64 data
    # itself is then removed from `meta` (none of it should reach the history).
    _bilder = _early_meta.get("bilder") if isinstance(_early_meta, dict) else None
    _dateien = _early_meta.get("dateien") if isinstance(_early_meta, dict) else None
    _anhang_texte: list[str] = []
    if isinstance(_bilder, list) and _bilder and isinstance(body.get("messages"), list):
        _litellm_url = os.environ.get("LITELLM_BASE_URL", "")
        _litellm_key = os.environ.get("LITELLM_MASTER_KEY", "")
        for _b in _bilder[:4]:
            if not isinstance(_b, dict):
                continue
            _name = str(_b.get("name") or "Bild")[:80]
            _b64 = _b.get("b64")
            if not isinstance(_b64, str) or not _b64:
                continue
            _desc = ""
            if not _test_mode_active(request, user) and _litellm_url and _litellm_key:
                try:
                    _desc = await bild_beschreiben(
                        _b64, _name, mime=str(_b.get("mime") or "image/jpeg"),
                        litellm_url=_litellm_url, litellm_key=_litellm_key,
                    )
                except Exception:  # noqa: BLE001
                    logger.exception("vision prelude for attachment failed")
            _anhang_texte.append(
                f"[Anhang Bild „{_name}“. Du siehst das Bild nicht selbst — diese "
                f"Beschreibung des Bildmodells IST dein Blick darauf; antworte damit, "
                f"sage nicht, du könnest das Bild nicht sehen: "
                f"{_desc.strip() if _desc else 'Beschreibung nicht verfügbar (Bildmodell antwortete nicht)'}]"
            )
    if isinstance(_dateien, list) and _dateien:
        for _d in _dateien[:6]:
            if isinstance(_d, dict) and _d.get("name"):
                _anhang_texte.append(f"[Anhang Datei „{str(_d['name'])[:80]}“ — Inhalt folgt im Kontext, falls lesbar]")
    if _anhang_texte and isinstance(body.get("messages"), list):
        for _i in range(len(body["messages"]) - 1, -1, -1):
            _m = body["messages"][_i]
            if _m.get("role") == "user":
                _uc = _m.get("content")
                _block = "\n".join(_anhang_texte)
                if isinstance(_uc, str):
                    _m["content"] = _block + "\n\n" + _uc
                elif isinstance(_uc, list):
                    _m["content"] = [{"type": "text", "text": _block}] + _uc
                break
    if isinstance(body.get("meta"), dict):
        body["meta"].pop("bilder", None)

    # ── Test-mode echo bypass ───────────────────────────────────────────
    if _test_mode_active(request, user):
        last_user_msg = ""
        for m in reversed(body.get("messages") or []):
            if m.get("role") == "user":
                content = m.get("content")
                if isinstance(content, str):
                    last_user_msg = content
                elif isinstance(content, list):
                    # Multipart (marker bbox-img/cad-object): join only text parts.
                    last_user_msg = " ".join(
                        str(p.get("text", ""))
                        for p in content
                        if isinstance(p, dict) and p.get("type") == "text"
                    )
                else:
                    last_user_msg = str(content or "")
                break
        echo_text = f"echo: {last_user_msg[:500]}"
        meta = body.get("meta") or {}
        # Reflect the pinned marker kind in the echo so backend tests can
        # assert that marker payloads reach this handler (without needing
        # an LLM round-trip).
        if isinstance(meta.get("marker"), dict):
            echo_text += f" [marker:kind={meta['marker'].get('kind')}]"
        stream_id = uuid.uuid4().hex[:12]
        await _stream_register(stream_id, user, meta)

        # Slow-mode (test_11_active_agents): X-Claraos-Test-Slow: true makes
        # the stream emit 5 chunks with 100 ms gaps so the active-streams
        # registry can actually be polled mid-flight.
        slow = (request.headers.get("x-claraos-test-slow") or "").lower() == "true"
        n_chunks = 5 if slow else 2
        chunk_delay_s = 0.1 if slow else 0.05

        chunks: list[str] = []
        if echo_text:
            step = max(1, (len(echo_text) + n_chunks - 1) // n_chunks)
            for i in range(0, len(echo_text), step):
                chunks.append(echo_text[i : i + step])
        if not chunks:
            chunks = [""]

        async def _echo_stream():
            try:
                for chunk in chunks:
                    if not chunk:
                        continue
                    await asyncio.sleep(chunk_delay_s)
                    await _stream_touch(stream_id)
                    yield (
                        "data: "
                        + json.dumps({"choices": [{"delta": {"content": chunk}}]})
                        + "\n\n"
                    ).encode()
                yield b"data: [DONE]\n\n"
            finally:
                await _stream_unregister(stream_id)

        return StreamingResponse(_echo_stream(), media_type="text/event-stream")

    token = await _get_webui_token(user, strict=False)

    # Inject ClaraOS app-context as a system message if app_id present.
    # Per-app templates so Clara knows what UI action to run
    # after computing a result via meta_platform_meta_run_task.
    meta = body.get("meta") or {}
    app_id = meta.get("app_id")
    # The app id lands in the trusted block — only a plain identifier may get there
    # ("x; chat_user: someone" would otherwise become an identity line).
    if not (isinstance(app_id, str) and _APP_ID_OK.fullmatch(app_id)):
        app_id = None
    object_uri = meta.get("object_uri")
    surface = meta.get("surface")
    # Identity spoofing: only the block THIS proxy writes may carry the marker.
    # Typed or replayed "[ClaraOS context]" text in any message is defused first.
    if isinstance(body.get("messages"), list):
        neutralize_context_markers(body["messages"])
    # Measurement run (test suite): honoured only for machine calls with the
    # service token; a browser behind the proxy cannot switch it on.
    messlauf = (is_service_call(request)
                and (request.headers.get("x-claraos-messlauf") or "").strip() == "1")
    # Not gated on `app_id` — `chat_user` must ALWAYS be injected so
    # claraos_action_* dispatches target the right user's Action-Bus WS, even
    # for the global start-menu chat (no focused app → app_id empty). Per-app
    # specifics below stay gated on app_id values.
    if isinstance(body.get("messages"), list) and body["messages"]:
        parts = []
        # Identity first: readers take the FIRST `chat_user:` of the block, and
        # every later part may contain client-supplied text.
        # WebUI strips body.user when forwarding to LiteLLM, so
        # encode the chat user inside the system-message so clara-agent can
        # target claraos_action_* dispatches at the right WebSocket.
        if chat_username:
            parts.append(f"chat_user: {chat_username}")
            # Signed identity (S1): anyone who reaches LiteLLM can set `user` and
            # write a context block; only this proxy holds the key. Not in a cell:
            # its brain identifies the turn by `chat_turn` (services/brain_turns.py).
            if not betriebsprofil.IS_CELL:
                parts.extend(identitaet.kontext_zeilen(chat_username))
        if messlauf:
            parts.append("messlauf: 1")
        # Pass the real chat ID — clara-agent derives its Redis session from
        # it (instead of a fingerprint of the first messages, which collided
        # for chats that started similarly → mixed-up context).
        chat_id = body.get("chat_id")
        if isinstance(chat_id, str) and re.fullmatch(r"[a-zA-Z0-9_\-]{1,64}", chat_id):
            parts.append(f"chat_session: {chat_id}")
        n_trusted = len(parts)
        if app_id:
            parts.append(f"active app: {app_id}")
        if surface:
            parts.append(f"surface: {surface}")
        if object_uri:
            parts.append(f"current object: {object_uri}")
        # Always on: asked to open a page, the agent kept picking artifact_ui
        # navigation (an internal window nobody looks at) over the user's
        # browser — and then opened an Immich album in the browser, where it
        # had no login. A line here outweighs any tool description.
        parts.append(
            "showing something to the user: inside a ClaraOS app (an Immich album, a "
            "Paperless document, …) use claraos_action_navigate_to / open_window — the "
            "app tile signs the user in; an app address in the browser lands on its "
            "login page. External websites: open_in_browser (the user's own browser; "
            "check final_url/title), look_at_browser to see what the user sees. "
            "artifact_ui_* tools act in a separate internal window the user does not "
            "look at."
        )

        # Per-app context expansion. Each branch may add specifics from
        # `meta` (current path, selection, etc.) and a `preferred actions`
        # hint so Clara prefers the right tools.
        if app_id in ("ideas", "knowledge"):
            # Inline chat on a KB object → put the object content directly
            # into the system message (visibility-checked), so Clara knows the
            # object without an initial get_object round trip. Applies to both
            # suites (Idea Suite + Knowledge Suite, one backend).
            m_obj = re.match(r"^claraos://(?:ideas|knowledge)/object/([0-9a-f-]{36})$", object_uri or "")
            if m_obj and chat_username:
                try:
                    from routers.knowledge import fetch_object_context
                    ctx = await fetch_object_context(m_obj.group(1), chat_username)
                    if ctx:
                        parts.append(ctx)
                except Exception as exc:  # context is nice-to-have, never blocking
                    logger.warning("%s context resolve failed: %s", app_id, exc)
            if app_id == "ideas":
                parts.append(
                    "preferred actions: knowledge_* tools — update_object/add_insight/"
                    "link_objects/promote_idea_to_plan mit der object_id oben; entwickle "
                    "die Idee dialogisch weiter und persistiere Ergebnisse ins Objekt "
                    "(body erweitern, stage vorantreiben), nicht nur im Chat."
                )
            else:
                parts.append(
                    "preferred actions: knowledge_* tools — update_object/add_insight/"
                    "link_objects mit der object_id oben; pflege Sammlungen und "
                    "Objekt-Properties und persistiere Ergebnisse ins Objekt, "
                    "nicht nur im Chat. Kein Stage-/Promote-Workflow (das ist die Idea Suite)."
                )
        elif _heim_app_kontext is not None and (_heim_teile := _heim_app_kontext(app_id, meta)) is not None:
            parts.extend(_heim_teile)
        elif app_id == "files":
            src = meta.get("source") or meta.get("current_source")
            cur_path = meta.get("current_path") or "/"
            sel_file = meta.get("selected_file")
            if src:
                parts.append(f"current source: {src}")
            parts.append(f"current path: {cur_path}")
            parts.append(f"selected file: {sel_file or '(none)'}")
            parts.append(
                "preferred actions: files_list_directory / files_read_file / "
                "files_write_file for I/O; claraos_action_navigate_files to "
                "drive the Files-app to a path; claraos_action_open_in_viewer "
                "to open the right viewer for the user."
            )
        elif app_id == "image-viewer":
            cur_path = meta.get("path")
            cur_src = meta.get("source") or "nextcloud"
            if cur_path:
                parts.append(f"viewing: {cur_path} (source={cur_src})")
            # Editing hints for the open image come from optional
            # installation-specific image tools (chat_kontext_heim.py).
            if _heim_kontext is not None:
                parts.extend(_heim_kontext.bildbetrachter_hinweise(chat_username))
        elif app_id == "pdf-viewer":
            cur_path = meta.get("path")
            if cur_path:
                parts.append(f"viewing: {cur_path}")
            parts.append("preferred actions: claraos_action_open_in_viewer for related docs")
        elif app_id == "office-viewer":
            cur_path = meta.get("path")
            if cur_path:
                parts.append(f"viewing: {cur_path}")
            parts.append(
                "preferred actions: claraos_action_office_insert(content, save?) schreibt "
                "LIVE an der Cursorposition ins offene Dokument (Markdown wird erkannt; "
                "mime='text/html' für explizite Formatierung) — nutze das für 'füge ein/"
                "ergänze/schreib in mein Dokument'. NEUES Dokument: "
                "claraos_modules_office__create_document(filename, content_markdown, folder?) "
                "und danach IMMER claraos_action_open_in_viewer(path, source='nextcloud'). "
                "NIEMALS files_write_file auf die offene Datei (kollidiert mit der "
                "laufenden Collabora-Session)."
            )
        elif app_id == "video-player":
            cur_path = meta.get("path")
            if cur_path:
                parts.append(f"playing: {cur_path}")
        elif app_id == "text-editor":
            cur_path = meta.get("path")
            sel_text = meta.get("selection_text")
            if cur_path:
                parts.append(f"editing: {cur_path}")
            if sel_text:
                snip = sel_text[:120] + ("…" if len(sel_text) > 120 else "")
                parts.append(f"selection: {snip}")
            parts.append(
                "preferred actions: text-editor_replace_string / "
                "text-editor_insert_at_line for in-file edits; "
                "claraos_action_show_artifact('code', ...) for short snippets"
            )
        elif app_id == "immich":
            # Perform photo/album tasks result-oriented via the Immich API
            # (NOT by clicking the UI) and let the user watch the album fill
            # up in the open Immich window.
            parts.append(
                "preferred actions: Foto-/Album-Aufgaben über die immich_* API-Tools, "
                "NICHT UI-Klicks. Workflow für 'lege ein Album mit Fotos von <Person> "
                "aus <Zeitraum> an': (1) find_person(name) → person_id ('von mir' = "
                "der Name des Nutzers selbst); (2) search_assets(person_ids, taken_after, "
                "taken_before) → asset_ids; (3) create_album(name) → album_id; "
                "(4) SOFORT das Album ins Blickfeld holen, damit der User zuschaut: "
                "claraos_action_navigate_to(app_id='immich', pattern_key='album', "
                "params={'id': album_id}); auf Mobile zusätzlich "
                "claraos_action_dispatch(app_id='shell', action='set_mobile_view', "
                "args={'app_id': 'immich'}) für die Split-Ansicht (Immich oben / "
                "Chat unten); "
                "(5) add_assets_to_album(album_id, asset_ids) — bei vielen Fotos in "
                "mehreren Aufrufen (Chunks), nach jedem Chunk erneut navigate_to zum "
                "Album, damit es sich sichtbar füllt; (6) Ergebnis kurz melden "
                "('N Fotos hinzugefügt'). Bei Korrekturen im Review "
                "('die unscharfen raus') remove_assets_from_album(album_id, asset_ids) "
                "und erneut das Album zeigen."
            )
        elif app_id and app_id not in ("startmenu", "quick", "shell"):
            # Generic hint for any other app: how to render results. Deliberately
            # no `meta_platform` here and nothing for the plain chat: a
            # "preferred actions" line beats every tool description, and it used
            # to send everyday questions (calendar, tasks) to a compute platform.
            parts.append(
                "preferred actions: claraos_action_open_in_viewer / claraos_action_open_window "
                "to render results in ClaraOS apps; a generated HTML page "
                "(game, chart, mini-app) belongs in claraos_action_show_artifact "
                "— it RUNS there."
            )

        # The user attached the shell's text report via the "read screen" chip
        # (the same thing read_screen would return — just BEFORE the question,
        # so Clara does not have to ask first).
        screen_report = meta.get("screen_report")
        if isinstance(screen_report, str) and screen_report.strip():
            parts.append(
                "screen (attached by the user, current view): "
                + screen_report.strip()[:2500]
            )

        # On the phone the reply is the surface — results arrive as a card in
        # the chat (with an open button); Clara does not open windows/viewers
        # unasked. Otherwise, after bild_erzeugen + open_in_viewer the chat
        # sheet disappeared and the user was left on the home screen.
        if surface == "quick":
            parts.append(
                "Handy-Chat: Ergebnisse (Bilder, Dateien, Aufgaben) NICHT automatisch mit "
                "claraos_action_open_in_viewer / open_window / set_mobile_view öffnen — "
                "die Karte im Chat hat einen Öffnen-Knopf. Öffne nur, wenn der Nutzer "
                "ausdrücklich 'öffne' oder 'zeig mir' sagt."
            )

        # Clara had no way to look at her own work: asked to "check it yourself
        # with screenshots", she ran docker_ps. And she reported success because
        # the tool said "delivered" — which only refers to the transport.
        parts.append(
            "checking your own work: claraos_action_read_screen tells you what "
            "the user really has on screen (open windows, visible text, error "
            "messages). Use it when asked to check, take a screenshot, or verify "
            "— NEVER answer that from docker/system tools. And a render tool that "
            "returns rendered: 0 means the user sees NOTHING: say so, do not "
            "claim success."
        )

        # The following hints only make sense inside their apps. Sent with every
        # message they cost context and pulled everyday questions towards tools
        # that were not even loaded.
        # Deep links: after an app's own lookup tool returns an entity id/slug,
        # jump that app's UI straight to it.
        if app_id in _DEEPLINK_APPS:
            parts.append(
                "deep-link: when the user wants to find/open a specific record in an "
                "iframe-app, first call that app's lookup tool to get the id/slug, then "
                "call claraos_action_navigate_to(app_id, pattern_key, params) to jump the "
                "app's window to it (it opens the window if not already open). Known: "
                + _DEEPLINK_KNOWN
            )

        # Hints of the installation's own apps (chat_kontext_heim.py).
        if _heim_kontext is not None:
            parts.extend(_heim_kontext.app_hinweise(app_id))

        if app_id == "immich":
            parts.append(
                "Immich Fotos/Alben: nutze immich_find_person + immich_search_assets "
                "(Person+Datum, exakt) + immich_create_album + immich_add_assets_to_album. "
                "NICHT die claraos_modules_media_immich__* Tools. "
                "Album danach zeigen: claraos_action_navigate_to('immich','album',{'id': album_id}); "
                "auf Mobile zusaetzlich claraos_action_dispatch(app_id='shell', "
                "action='set_mobile_view', args={'app_id': 'immich'})."
            )
        # Kids mode — guardrails against parasocial attachment, data
        # minimisation, referral to parents (group claraos-kids via SSO header).
        if "claraos-kids" in (user.get("groups") or []):
            parts.append(
                "KINDER-MODUS (dieser User ist ein Kind): Sprich einfach und "
                "altersgerecht. Erinnere in längeren Gesprächen beiläufig daran, "
                "dass du ein Computerprogramm bist — keine Gefühle, kein Mensch. "
                "KEIN Freundschafts-/Beziehungs-Framing ('ich vermisse dich' u. ä. "
                "ist tabu). Profil: nur Interessen/Ziele/Vorlieben speichern — "
                "NIE Gefühle, Gesundheit, Geheimnisse oder Familienkonflikte, auch "
                "nicht auf Wunsch. Bei belastenden Themen einfühlsam bleiben und "
                "IMMER an die Eltern verweisen. Sag ehrlich dazu, dass die Eltern "
                "das Profil einsehen können, wenn es ums Merken geht."
            )
        # Guide: the user's curated profile block in every chat — or the
        # getting-to-know-you protocol while there is none yet. Chat must never
        # fail because of this (load_profile never raises).
        if chat_username:
            from routers.guide import load_profile as _guide_load_profile
            _profil = await _guide_load_profile(chat_username)
            if _profil:
                parts.append(
                    "User-Profil (von dir über diesen User gelernt — nutze es für "
                    "Ton, App-Empfehlungen und Touren; beziehe dich auf Gelerntes "
                    "immer sichtbar, z. B. 'du hattest erzählt …'): "
                    + json.dumps(_profil, ensure_ascii=False)[:1500]
                    + ". Änderungen NUR nach Bestätigung des Users via "
                    "guide_update_profile; er kann alles in Einstellungen → "
                    "'Was Clara über mich weiß' einsehen und ändern."
                )
            else:
                parts.append(
                    "Guide: du kennst diesen User noch NICHT (kein Profil). Wenn er "
                    "neu wirkt oder Orientierung sucht: stelle dich kurz und warm vor "
                    "(ehrlich als KI, keine simulierten Gefühle), stelle höchstens 1-2 "
                    "Kennenlern-Fragen auf einmal (Ziele, Technik-Komfort, Vorlieben) "
                    "und lass jede Antwort sofort etwas Sichtbares bewirken — passende "
                    "App/Funktion zeigen (guide_capabilities, guide_show_tour, "
                    "guide_start_tour) statt Fragebogen abarbeiten. Fasse Gelerntes "
                    "zusammen, frage 'Darf ich mir das merken?' und speichere erst "
                    "nach einem Ja via guide_update_profile."
                )
        # External cell: no clara-agent, no tools — strip tool instructions,
        # otherwise the model claims actions that never happen.
        # Everything after the identity lines may carry client text (app state,
        # screen report, object bodies): it must not be able to add an identity
        # or flag line, nor end the block early with a blank line.
        parts = parts[:n_trusted] + [_defuse_part(p) for p in parts[n_trusted:]]
        if betriebsprofil.IS_CELL and brain_turns.enabled() and chat_username:
            parts = betriebsprofil.gehirn_kontext(parts, brain_turns.issue(chat_username))
        elif betriebsprofil.IS_CELL:
            parts = betriebsprofil.werkzeugfreier_kontext(parts)
        ctx = "[ClaraOS context] " + "; ".join(parts)
        # WebUI strips/replaces injected system messages, so we ALSO prepend
        # the context to the LAST user message — clara-agent reads chat_user
        # from there to target Action-Bus dispatches at the right WebSocket.
        body["messages"].insert(0, {"role": "system", "content": ctx})
        for i in range(len(body["messages"]) - 1, -1, -1):
            m = body["messages"][i]
            if m.get("role") == "user":
                user_content = m.get("content")
                if isinstance(user_content, str):
                    m["content"] = ctx + "\n\n" + user_content
                elif isinstance(user_content, list):
                    # OpenAI multipart format — prepend a text part
                    m["content"] = [{"type": "text", "text": ctx}] + user_content
                break

    # Marker injection now happens BEFORE the test-mode bypass (see _early_marker
    # block above) so both paths see the mutation. The block ran before the
    # ClaraOS-context-system-message was prepended; that's fine — chat_v2.py
    # context goes into a separate message slot, and the marker block sits in
    # the user message. Order in user message: marker-block → ctx-prefix → original
    # text → optional image_url.

    stream_id = uuid.uuid4().hex[:12]
    await _stream_register(stream_id, user, meta)

    # The upstream is read to the end in its OWN task, not inside the response
    # generator. Before, a closed tab or a lost phone connection cancelled the
    # generator, which closed the upstream request, and the agent dropped the
    # run; the shell had only saved up to its last commit. Now the run finishes
    # regardless, and if the client is gone by then, the proxy writes the
    # answer into the chat itself (see services/chat_lauf.py).
    chat_id_raw = body.get("chat_id")
    lauf = _ServerLauf(
        user=user, stream_id=stream_id,
        chat_id=chat_id_raw if isinstance(chat_id_raw, str)
        and re.fullmatch(r"[a-zA-Z0-9_\-]{1,64}", chat_id_raw) else None,
        frage=frage_text,
        username=chat_username,
    )
    task = asyncio.create_task(_lauf_ausfuehren(lauf, body, token))
    lauf.task = task
    _LAEUFE[stream_id] = lauf
    task.add_done_callback(lambda _t, sid=stream_id: _LAEUFE.pop(sid, None))

    async def _stream():
        try:
            while True:
                item = await lauf.queue.get()
                if item is None:
                    break
                yield item
        finally:
            if not lauf.fertig:
                lauf.client_weg = True
                logger.info("chat v2: client left stream %s early; the run continues server-side",
                            stream_id)

    # The stop button needs the id: a closed connection no longer stops the run.
    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"X-Claraos-Stream-Id": stream_id})


@router.post("/streams/{stream_id}/cancel")
async def cancel_stream(stream_id: str, request: Request) -> JSONResponse:
    """Stop button: end a running answer on purpose (own runs only).

    Since the run continues when the browser goes away, closing the request is
    no longer a stop signal. Cancelling the task closes the upstream request;
    the agent then drops the run as before. Nothing is stored afterwards.
    """
    user = get_current_user(request)
    lauf = _LAEUFE.get(stream_id)
    if not lauf or (lauf.user.get("username") or "").lower() != (user.get("username") or "").lower():
        return JSONResponse(status_code=404, content={"ok": False, "detail": "Kein laufender Auftrag mit dieser Kennung."})
    lauf.abgebrochen = True
    lauf.client_weg = True
    # Closing the upstream alone no longer stops the agent (it finishes orphaned
    # runs), so it is told first; only then is the connection closed.
    agent = await _agent_stoppen(lauf)
    if lauf.task and not lauf.task.done():
        lauf.task.cancel()
    logger.info("chat v2: run %s cancelled by its user (agent stopped: %s)", stream_id,
                (agent or {}).get("stopped"))
    return JSONResponse(content={"ok": True, "cancelled": stream_id,
                                 "agent_stopped": (agent or {}).get("stopped")})


async def _agent_stoppen(lauf: "_ServerLauf") -> dict | None:
    """POST /v1/chat/stop {chat_session, user} to clara-agent; never raises.

    The agent keys its running turns by (user, chat_session) — the same values
    this proxy writes into the context block. Not in a cell: its brain is a
    different service.
    """
    if betriebsprofil.IS_CELL or not lauf.chat_id or not lauf.username:
        return None
    try:
        from auth import clara_agent_headers
        url = heim_default("CLARA_AGENT_ADMIN_URL").rstrip("/") + "/v1/chat/stop"
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(url, json={"chat_session": lauf.chat_id, "user": lauf.username},
                                  headers=clara_agent_headers())
        return r.json() if r.status_code == 200 else {"stopped": False, "status": r.status_code}
    except Exception as exc:  # noqa: BLE001 — stopping is best effort
        logger.warning("chat v2: agent stop failed: %s", type(exc).__name__)
        return None


# ── Server-side run (the answer survives the closed browser) ────────────────
# Strong references: a task that nobody holds can be garbage-collected mid-run.
_LAEUFE: dict = {}


class _ServerLauf:
    def __init__(self, *, user: dict, stream_id: str, chat_id: str | None, frage: str,
                 username: str) -> None:
        self.user = user
        self.stream_id = stream_id
        self.chat_id = chat_id
        self.frage = frage
        self.username = username
        self.queue: asyncio.Queue = asyncio.Queue()
        self.antwort = chat_lauf.Antwort()
        self.client_weg = False
        self.fertig = False
        self.karten: list[asyncio.Task] = []
        self.task: asyncio.Task | None = None
        self.abgebrochen = False
        # Set by drain(): the API is shutting down and the run did not finish in time.
        self.unterbrochen = False

    def senden(self, item: bytes) -> None:
        if not self.client_weg:
            self.queue.put_nowait(item)


async def _entwurfskarte(lauf: _ServerLauf, draft_id: str) -> None:
    """Turn a stored mail draft into a card with Send / Open / Discard buttons."""
    if not lauf.username:
        return
    try:
        from routers.mail import draft_preview
        preview = await draft_preview(lauf.username, draft_id)
    except Exception:  # noqa: BLE001 — the card is optional
        logger.exception("draft card failed")
        return
    if not preview:
        return
    ev = {"type": "ui.block", "block": chat_lauf.draft_block(preview)}
    lauf.antwort.apply_event(ev)
    lauf.senden(chat_lauf.sse_frame_for_event(ev))


async def _job_binden(lauf: _ServerLauf, ev: dict) -> None:
    """A job event in the stream: bind the job to this user and this chat.

    The agent only knows the job; the proxy knows who is chatting and where.
    Later job.done/job.failed arrive without a stream (routers/jobs.py) and
    find the chat here.
    """
    if not lauf.username:
        return
    try:
        from routers.jobs import ereignis_verarbeiten
        await ereignis_verarbeiten(lauf.username, ev, chat_id=lauf.chat_id or "")
    except Exception:  # noqa: BLE001 — the card is shown anyway, only the binding is lost
        logger.exception("chat v2: job event could not be stored")


async def _lauf_ausfuehren(lauf: _ServerLauf, body: dict, token: str) -> None:
    # Warning: a plain `timeout=120` ALSO sets the read timeout to 120 s. Real
    # research (web searches + several model rounds) regularly has longer
    # pauses between two chunks — the stream then died mid-work with
    # `stream_failed` and an EMPTY detail (str(ReadTimeout) is ""), giving
    # the user no hint at all. The agent deliberately has no hard time
    # limit (long agent tasks routinely take >5 min) — this proxy in
    # front of it must not impose one either.
    # Connecting stays short (a dead upstream should be noticed quickly);
    # only waiting for the next chunk is generous.
    stream_timeout = httpx.Timeout(connect=10.0, read=900.0, write=60.0, pool=10.0)
    puffer = ""
    gesehene_entwuerfe: set[str] = set()
    try:
        async with httpx.AsyncClient(timeout=stream_timeout) as client:
            async with client.stream(
                "POST",
                f"{OPENWEBUI_URL.rstrip('/')}/api/chat/completions",
                json=body,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "text/event-stream",
                },
            ) as resp:
                async for text in resp.aiter_text():
                    if not text:
                        continue
                    await _stream_touch(lauf.stream_id)
                    puffer += text
                    # Forward complete lines only, so an inserted card frame
                    # never lands in the middle of an upstream frame.
                    *zeilen, puffer = puffer.split("\n")
                    if not zeilen:
                        continue
                    lauf.senden(("\n".join(zeilen) + "\n").encode())
                    for zeile in zeilen:
                        for ev in lauf.antwort.apply_line(zeile):
                            if ev.get("type") in ("job.started", "job.done", "job.failed"):
                                lauf.karten.append(asyncio.create_task(_job_binden(lauf, ev)))
                            did = chat_lauf.draft_id_from_event(ev)
                            if did and did not in gesehene_entwuerfe:
                                gesehene_entwuerfe.add(did)
                                lauf.karten.append(asyncio.create_task(_entwurfskarte(lauf, did)))
                if puffer:
                    lauf.senden(puffer.encode())
                    lauf.antwort.apply_line(puffer)
    except asyncio.CancelledError:
        if lauf.unterbrochen:
            # Shutdown deadline passed: keep what is there and say why it ends here.
            hinweis = "\n\n_(Antwort unterbrochen: ClaraOS wurde neu gestartet. Frag gern noch einmal nach.)_"
            lauf.antwort.content += hinweis
            lauf.senden(("data: " + json.dumps({"choices": [{"delta": {"content": hinweis}}]})
                         + "\n\n").encode())
        lauf.senden(b"data: [DONE]\n\n")
    except Exception as exc:  # noqa: BLE001
        logger.exception("chat v2 stream error")
        # Include the type — `str(ReadTimeout)` is empty, and the
        # frontend would show an error message with no content.
        detail = f"{type(exc).__name__}: {exc}".rstrip(": ")
        lauf.antwort.fehler = detail[:300]
        lauf.senden(('data: {"error":"stream_failed","detail":' + json.dumps(detail) + "}\n\n").encode())
        lauf.senden(b"data: [DONE]\n\n")
    finally:
        if lauf.karten:
            await asyncio.gather(*lauf.karten, return_exceptions=True)
        lauf.fertig = True
        lauf.queue.put_nowait(None)
        await _stream_unregister(lauf.stream_id)
    if lauf.client_weg and not lauf.abgebrochen:
        await _antwort_nachtragen(lauf)


async def _antwort_nachtragen(lauf: _ServerLauf) -> None:
    """The client left before the end: write the finished answer into the chat."""
    if not lauf.chat_id or not lauf.antwort.has_content():
        logger.info("chat v2: run %s finished without client, nothing to store (chat=%s)",
                    lauf.stream_id, bool(lauf.chat_id))
        return
    try:
        resp = await _webui_request(lauf.user, "GET", f"/api/v1/chats/{lauf.chat_id}")
        if resp.status_code != 200:
            logger.warning("chat v2: cannot read chat %s to store the answer (%s)",
                           lauf.chat_id, resp.status_code)
            return
        stored = ((resp.json() or {}).get("chat") or {}).get("messages") or []
        merged = chat_lauf.merge_into_history(stored, lauf.frage, lauf.antwort.as_message())
        resp = await _webui_request(lauf.user, "POST", f"/api/v1/chats/{lauf.chat_id}",
                                    json_body={"chat": {"messages": merged}})
        logger.info("chat v2: answer of run %s stored server-side in chat %s (%s, %d chars)",
                    lauf.stream_id, lauf.chat_id, resp.status_code, len(lauf.antwort.content))
    except Exception:  # noqa: BLE001
        logger.exception("chat v2: storing the answer after disconnect failed")


def laufende_anzahl() -> int:
    """Server-side runs still working (with or without a connected client)."""
    return sum(1 for lauf in list(_LAEUFE.values()) if lauf.task and not lauf.task.done())


async def drain(frist_s: float) -> dict:
    """Shutdown: let running chat answers finish, at most `frist_s` seconds.

    Called from the lifespan shutdown. By then uvicorn has closed the client
    connections, so every run is `client_weg` and stores its answer in the
    chat when it ends (_antwort_nachtragen). A run still busy at the deadline
    is cancelled; what it has so far is stored with a note instead of being
    lost with the container.
    """
    tasks = [lauf.task for lauf in list(_LAEUFE.values()) if lauf.task and not lauf.task.done()]
    if not tasks:
        return {"laufend": 0, "fertig": 0, "unterbrochen": 0}
    logger.info("chat v2: shutdown — waiting up to %.0f s for %d running answer(s)", frist_s, len(tasks))
    done, pending = await asyncio.wait(tasks, timeout=max(0.0, frist_s))
    if pending:
        offen = [lauf for lauf in list(_LAEUFE.values()) if lauf.task in pending]
        # The agent would otherwise go on acting after the answer was stored as
        # interrupted.
        await asyncio.gather(*(_agent_stoppen(lauf) for lauf in offen), return_exceptions=True)
        for lauf in offen:
            lauf.unterbrochen = True
            lauf.client_weg = True
            lauf.task.cancel()
        # Storing the partial answer is one or two calls to Open WebUI.
        await asyncio.wait(pending, timeout=10.0)
    logger.info("chat v2: shutdown drain — %d finished, %d interrupted", len(done), len(pending))
    return {"laufend": len(tasks), "fertig": len(done), "unterbrochen": len(pending)}


@router.get("/laeufe/anzahl")
async def laeufe_anzahl(request: Request) -> JSONResponse:
    """How many chat answers are running right now (deploy waits for 0).

    Machine callers only; the number is all a deploy needs, no names.
    """
    if not is_service_call(request):
        raise HTTPException(status_code=403, detail="Nur für Dienste.")
    return JSONResponse(content={"laufend": laufende_anzahl()})


@router.get("/active-streams")
async def active_streams(request: Request) -> JSONResponse:
    """Return all currently-streaming completions for the calling user.

    Used by the start menu's active-agents panel to show a live list of what
    Clara is working on. Stale entries (no delta in >120 s) are filtered out
    automatically.
    """
    user = get_current_user(request)
    username = (user.get("username") or "dev").lower()
    now = time.time()
    items = []
    async with _streams_lock:
        for info in _active_streams.values():
            if (info.get("user") or "").lower() != username:
                continue
            if now - info.get("last_delta_at", 0) > 120:
                continue
            items.append({
                **info,
                "duration_s": round(now - info["started_at"], 1),
            })
    return JSONResponse(content={"streams": items, "count": len(items)})


# ---------------------------------------------------------------------------
# File upload (forwarded to /api/v1/files)
# ---------------------------------------------------------------------------

@router.post("/files")
async def upload_file(request: Request, file: UploadFile = File(...)) -> JSONResponse:
    """Forward a multipart file upload to Open WebUI's file store."""
    user = get_current_user(request)
    token = await _get_webui_token(user, strict=False)
    content = await file.read()
    files_data = {"file": (file.filename, content, file.content_type or "application/octet-stream")}
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            f"{OPENWEBUI_URL.rstrip('/')}/api/v1/files/",
            files=files_data,
            headers={"Authorization": f"Bearer {token}"},
        )
    return _passthrough(resp)


# ---------------------------------------------------------------------------
# Audio (STT / TTS — passthrough to WebUI which uses Speaches)
# ---------------------------------------------------------------------------

@router.post("/audio/transcribe")
async def transcribe(request: Request, file: UploadFile = File(...), language: str = Form("de")) -> JSONResponse:
    """Forward a recorded audio blob to WebUI's STT endpoint (Speaches)."""
    user = get_current_user(request)
    token = await _get_webui_token(user, strict=False)
    content = await file.read()
    files_data = {"file": (file.filename or "audio.webm", content, file.content_type or "audio/webm")}
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            f"{OPENWEBUI_URL.rstrip('/')}/api/v1/audio/transcriptions",
            files=files_data,
            data={"language": language},
            headers={"Authorization": f"Bearer {token}"},
        )
    return _passthrough(resp)


def live_voice_users() -> set[str]:
    """Users whose phone orb starts the live conversation (comma list, read at call time)."""
    raw = heim_default("CLARAOS_LIVE_VOICE_USERS")
    return {u.strip().lower() for u in raw.split(",") if u.strip()}


@router.get("/voice/config")
async def voice_config(request: Request) -> JSONResponse:
    """Which voice mode the phone orb uses for the signed-in user.

    `live: true` — the orb starts the live conversation on the voice server
    (full duplex) instead of the record → send → read-aloud loop. The list
    should match the voice agent's own allow list for its live engine; an
    empty list keeps everyone on the classic loop.
    """
    user = get_current_user(request)
    return JSONResponse({"live": (user.get("username") or "").lower() in live_voice_users()})


@router.get("/voice/token")
async def voice_token(request: Request) -> JSONResponse:
    """LiveKit access for live conversation mode.

    Per-user room (fresh per session — rooms live on for ~20 s after a
    disconnect, and re-joining would hit a deaf agent) + token from the shim
    (voice service).
    """
    user = get_current_user(request)
    room = f"clara-voice-{user['username']}-{uuid.uuid4().hex[:8]}"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                f"{LIVEKIT_SHIM_URL.rstrip('/')}/token",
                params={"identity": user["username"], "room": room},
                # The shim is fail-closed — machine callers must identify themselves
                headers={
                    "X-ClaraOS-Service-Token": os.environ.get(
                        "CLARAOS_SERVICE_TOKEN", ""
                    )
                },
            )
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPError as e:
        return JSONResponse(
            content={"error": "voice_unavailable", "detail": str(e)[:200]},
            status_code=503,
        )
    return JSONResponse({"token": data["token"], "url": VOICE_WS_URL, "room": room})


@router.post("/audio/speech")
async def speech(request: Request) -> Response:
    """TTS: directly against Speaches (OpenAI shape), falling back to WebUI.

    Body matches OpenAI: { model, input, voice, response_format }. Returns the
    raw audio bytes (audio/wav or audio/mpeg) that the browser plays directly.
    sample_rate is set explicitly — without it Speaches labels Piper audio as
    24 kHz without resampling (too fast, chipmunk voice).
    """
    user = get_current_user(request)
    body = await request.json()

    # Supertonic is the default voice. Older cached frontends may still send
    # a Piper model name — rewrite to the default server-side so NO client
    # rebuild is needed. The service handles wav|pcm; everything else falls
    # back to the old Speaches chain.
    resp = None
    fmt = str(body.get("response_format", "wav")).lower()
    if fmt in ("wav", "pcm"):
        st_body = dict(body)
        if not str(st_body.get("model", "")).startswith("supertonic"):
            st_body["model"] = TTS_DEFAULT_MODEL
            st_body["voice"] = TTS_DEFAULT_VOICE
        st_body.pop("sample_rate", None)  # service always returns 24 kHz
        async with httpx.AsyncClient(timeout=60) as client:
            try:
                resp = await client.post(
                    f"{SUPERTONIC_URL.rstrip('/')}/v1/audio/speech",
                    json=st_body,
                    headers={"Content-Type": "application/json"},
                )
            except httpx.HTTPError:
                resp = None
        if resp is not None and resp.status_code == 200:
            return Response(
                content=resp.content,
                media_type=resp.headers.get("content-type", "audio/wav"),
            )
        resp = None

    body.setdefault("sample_rate", TTS_SAMPLE_RATE)
    async with httpx.AsyncClient(timeout=60) as client:
        try:
            resp = await client.post(
                f"{SPEACHES_URL.rstrip('/')}/v1/audio/speech",
                json=body,
                headers={"Content-Type": "application/json"},
            )
        except httpx.HTTPError:
            resp = None
        if resp is None or resp.status_code != 200:
            # Fallback: old WebUI path (transcodes to MP3; rate may be wrong,
            # but better than no voice at all when Speaches is down)
            token = await _get_webui_token(user, strict=False)
            resp = await client.post(
                f"{OPENWEBUI_URL.rstrip('/')}/api/v1/audio/speech",
                json={k: v for k, v in body.items() if k != "sample_rate"},
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
            )
    if resp.status_code != 200:
        return JSONResponse(
            content={"error": "tts_failed", "status": resp.status_code, "detail": resp.text[:300]},
            status_code=resp.status_code,
        )
    return Response(
        content=resp.content,
        media_type=resp.headers.get("content-type", "audio/wav"),
    )


@router.get("/health")
async def health() -> JSONResponse:
    """Lightweight health-check for the v2 proxy + upstream WebUI."""
    out: dict = {
        "openwebui_url": OPENWEBUI_URL,
        "has_api_key": bool(OPENWEBUI_API_KEY),
    }
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{OPENWEBUI_URL.rstrip('/')}/api/config")
            out["openwebui_status"] = r.status_code
            if r.status_code == 200:
                cfg = r.json()
                out["openwebui_version"] = cfg.get("version")
                out["features"] = list((cfg.get("features") or {}).keys())[:10]
    except Exception as exc:  # noqa: BLE001
        out["openwebui_status"] = f"error:{type(exc).__name__}"
    return JSONResponse(content=out)
