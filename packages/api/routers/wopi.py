"""Minimal WOPI host for the ClaraOS office viewer.

Previously the office viewer embedded Collabora NESTED inside Nextcloud
(/f/<fileId> -> richdocuments -> Collabora iframe). That made Collabora's
postMessage host API unreachable for the shell (only the direct parent frame
may talk to it), so Clara could never write into the open document. This
router makes claraos-api itself the WOPI host, so the shell embeds cool.html
DIRECTLY and talks to the session via postMessage (Action_Paste, Action_Save).

Deliberately minimal:
  * Only CheckFileInfo / GetFile / PutFile. `SupportsLocks: false`; lock
    operations are 200 no-ops (Collabora does not require locks and
    deduplicates sessions itself per WopiSrc).
  * file_id = Nextcloud fileId -> stable WopiSrc per file, so several ClaraOS
    windows/users end up in ONE collaborative session.
  * Conflict protection: PutFile compares X-COOL-WOPI-Timestamp with the real
    WebDAV mtime; on drift it returns 409 {"COOLStatusCode": 1010}, so
    Collabora shows its "modified externally" dialog instead of silently
    overwriting (also mitigates a parallel Nextcloud web session).

Auth model: /token mints a short-lived session token (get_current_user, i.e.
cookie/Authentik behind the reverse proxy). The /files/* endpoints
authenticate EXCLUSIVELY via ?access_token=... (Collabora knows no cookies or
secrets); the reverse proxy's auth bypass lets only these paths through
without Authentik. Backend = the same per-user WebDAV logic as files_v2 (no
new permissions).
"""
from __future__ import annotations

from betriebsprofil import heim_default  # external deployments: no silent home-server fallback
import logging
import os
import secrets
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from auth import get_current_user
from database import get_pool, user_tx
from routers.files import _auth_header, _nc_credentials, _webdav_url
import domains_generated as domains

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/wopi", tags=["wopi"])

# Public base URL under which Collabora reaches our WOPI endpoints.
WOPI_PUBLIC_BASE = os.environ.get(
    "CLARAOS_PUBLIC_URL", domains.shell_url()
).rstrip("/")

TOKEN_TTL_S = 10 * 3600  # Collabora session length; the frontend re-mints on expiry
_PUT_MAX_BYTES = 512 * 1024 * 1024  # largest document Collabora may save back

# convert-to uses the same internal base (office.py); discovery returns the
# public urlsrc including the version hash (/browser/<hash>/cool.html?).
# Without the hash, cool.html builds a broken WS URI ("Invalid URI", the
# document never loads).
COLLABORA_INTERNAL_URL = heim_default("COLLABORA_CONVERT_URL").rstrip("/")

_editor_url_cache: tuple[float, str] | None = None

_tables_ensured = False


async def _editor_url() -> str:
    """urlsrc from /hosting/discovery, cached ~10 min (only changes on a
    Collabora upgrade)."""
    global _editor_url_cache
    import time as _time
    if _editor_url_cache and _time.monotonic() - _editor_url_cache[0] < 600:
        return _editor_url_cache[1]
    import re as _re
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{COLLABORA_INTERNAL_URL}/hosting/discovery")
        m = _re.search(r'urlsrc="([^"]+)"', resp.text)
        if m:
            _editor_url_cache = (_time.monotonic(), m.group(1))
            return m.group(1)
    except Exception:
        logger.warning("wopi: discovery nicht erreichbar", exc_info=True)
    # Fallback without hash: works only partially, but better than a 500
    return domains.url("collabora", "/browser/dist/cool.html?")


async def _ensure_tables() -> None:
    global _tables_ensured
    if _tables_ensured:
        return
    pool = await get_pool()
    async with pool.acquire() as conn:
        try:
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS claraos_wopi_tokens (
                    token       TEXT PRIMARY KEY,
                    username    TEXT NOT NULL,
                    source      TEXT NOT NULL,
                    path        TEXT NOT NULL,
                    file_id     TEXT NOT NULL,
                    can_write   BOOLEAN NOT NULL DEFAULT TRUE,
                    created_at  TIMESTAMPTZ DEFAULT NOW(),
                    expires_at  TIMESTAMPTZ NOT NULL
                )
            """)
        except Exception:
            logger.debug("wopi tokens: CREATE race ignoriert", exc_info=True)
    _tables_ensured = True


# ── WebDAV helpers (per user, like files_v2) ──────────────────────────────────

async def _propfind_meta(nc_user: str, nc_pass: str, path: str) -> dict:
    """Size, mtime (datetime, UTC) and fileId of a file."""
    body = ('<?xml version="1.0"?>'
            '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">'
            '<d:prop><d:getcontentlength/><d:getlastmodified/><oc:fileid/></d:prop>'
            '</d:propfind>')
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.request(
            "PROPFIND", _webdav_url(nc_user, path),
            headers={**_auth_header(nc_user, nc_pass), "Depth": "0",
                     "Content-Type": "application/xml"},
            content=body,
        )
    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="Datei nicht gefunden")
    if resp.status_code not in (200, 207):
        raise HTTPException(status_code=502, detail=f"Nextcloud PROPFIND {resp.status_code}")
    import re as _re
    size_m = _re.search(rb"<d:getcontentlength>(\d+)</d:getcontentlength>", resp.content)
    mtime_m = _re.search(rb"<d:getlastmodified>([^<]+)</d:getlastmodified>", resp.content)
    fid_m = _re.search(rb"<oc:fileid>(\d+)</oc:fileid>", resp.content)
    mtime = None
    if mtime_m:
        try:
            mtime = parsedate_to_datetime(mtime_m.group(1).decode()).astimezone(timezone.utc)
        except Exception:
            mtime = None
    return {
        "size": int(size_m.group(1)) if size_m else 0,
        "mtime": mtime,
        "file_id": fid_m.group(1).decode() if fid_m else "",
    }


def _iso(dt: datetime | None) -> str:
    """Collabora convention: ISO-8601 with microseconds + Z."""
    if dt is None:
        dt = datetime.now(timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


# ── Token ────────────────────────────────────────────────────────────────────

class _TokenBody(BaseModel):
    source: str = "nextcloud"
    path: str


@router.post("/token")
async def mint_token(body: _TokenBody, request: Request) -> dict:
    """WOPI session token for the frontend (authenticated, behind Authentik)."""
    user = get_current_user(request)
    username = user.get("username") or ""
    if not username:
        raise HTTPException(status_code=401, detail="Kein User")
    if body.source != "nextcloud":
        raise HTTPException(status_code=400, detail="WOPI nur für Nextcloud-Quellen")
    path = body.path.strip("/")
    if not path or ".." in path.split("/"):
        raise HTTPException(status_code=422, detail="Ungültiger Pfad")

    nc_user, nc_pass = await _nc_credentials(username)
    meta = await _propfind_meta(nc_user, nc_pass, path)
    if not meta["file_id"]:
        raise HTTPException(status_code=502, detail="fileId nicht ermittelbar")

    await _ensure_tables()
    token = secrets.token_urlsafe(32)
    # Housekeeping across all users (expired tokens) — plain pool on purpose.
    pool = await get_pool()
    await pool.execute(
        "DELETE FROM claraos_wopi_tokens WHERE expires_at < NOW() - interval '1 day'"
    )
    async with user_tx(username) as conn:
        await conn.execute(
            """
            INSERT INTO claraos_wopi_tokens
                (token, username, source, path, file_id, expires_at)
            VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(secs => $6))
            """,
            token, username, body.source, path, meta["file_id"], float(TOKEN_TTL_S),
        )
    return {
        "wopi_src": f"{WOPI_PUBLIC_BASE}/api/claraos/wopi/files/{meta['file_id']}",
        "access_token": token,
        # Collabora convention: expiry as epoch milliseconds
        "access_token_ttl": int(
            (datetime.now(timezone.utc).timestamp() + TOKEN_TTL_S) * 1000
        ),
        "file_id": meta["file_id"],
        "path": path,
        # Full editor URL (with version hash from /hosting/discovery)
        "editor_url": await _editor_url(),
    }


async def _resolve_token(file_id: str, access_token: str) -> dict:
    """Token -> row; 401 if unknown/expired, 404 on file_id mismatch."""
    if not access_token:
        raise HTTPException(status_code=401, detail="access_token fehlt")
    await _ensure_tables()
    # Authentication path for Collabora: the token is the only credential and
    # the user is not known yet — deliberately on the plain pool (no user RLS).
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT username, source, path, file_id, can_write
            FROM claraos_wopi_tokens
            WHERE token = $1 AND expires_at > NOW()
            """,
            access_token,
        )
    if not row:
        raise HTTPException(status_code=401, detail="Ungültiges oder abgelaufenes Token")
    if not secrets.compare_digest(row["file_id"], file_id):
        raise HTTPException(status_code=404, detail="Datei nicht zu diesem Token")
    return dict(row)


# ── WOPI: CheckFileInfo / GetFile / PutFile ─────────────────────────────────

@router.get("/files/{file_id}")
async def check_file_info(file_id: str, request: Request) -> JSONResponse:
    tok = await _resolve_token(file_id, request.query_params.get("access_token", ""))
    nc_user, nc_pass = await _nc_credentials(tok["username"])
    meta = await _propfind_meta(nc_user, nc_pass, tok["path"])
    basename = tok["path"].rsplit("/", 1)[-1]
    return JSONResponse(content={
        "BaseFileName": basename,
        "Size": meta["size"],
        "OwnerId": tok["username"],
        "UserId": tok["username"],
        "UserFriendlyName": tok["username"],
        "UserCanWrite": bool(tok["can_write"]),
        "SupportsUpdate": True,
        "SupportsLocks": False,
        "UserCanNotWriteRelative": True,
        "LastModifiedTime": _iso(meta["mtime"]),
        # Without PostMessageOrigin, Collabora neither sends nor accepts host postMessages
        "PostMessageOrigin": WOPI_PUBLIC_BASE,
    })


@router.get("/files/{file_id}/contents")
async def get_file(file_id: str, request: Request) -> Response:
    tok = await _resolve_token(file_id, request.query_params.get("access_token", ""))
    nc_user, nc_pass = await _nc_credentials(tok["username"])
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.get(
            _webdav_url(nc_user, tok["path"]), headers=_auth_header(nc_user, nc_pass)
        )
    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="Datei nicht gefunden")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Nextcloud GET {resp.status_code}")
    return Response(content=resp.content, media_type="application/octet-stream")


@router.post("/files/{file_id}/contents")
async def put_file(file_id: str, request: Request) -> JSONResponse:
    tok = await _resolve_token(file_id, request.query_params.get("access_token", ""))
    if not tok["can_write"]:
        raise HTTPException(status_code=403, detail="Nur Lesezugriff")
    override = request.headers.get("X-WOPI-Override", "PUT").upper()
    if override not in ("PUT",):
        # PUT_RELATIVE etc. are disabled via UserCanNotWriteRelative
        raise HTTPException(status_code=501, detail=f"X-WOPI-Override {override} nicht unterstützt")

    nc_user, nc_pass = await _nc_credentials(tok["username"])

    # Conflict detection: Collabora sends the version it knows as
    # X-COOL-WOPI-Timestamp; if the real mtime differs, the file was changed
    # externally (e.g. a Nextcloud web session) -> 1010 instead of silently
    # overwriting.
    cool_ts = request.headers.get("X-COOL-WOPI-Timestamp", "")
    if cool_ts:
        meta = await _propfind_meta(nc_user, nc_pass, tok["path"])
        if meta["mtime"] is not None and _iso(meta["mtime"]) != cool_ts:
            logger.warning(
                "wopi PutFile Konflikt %s: cool_ts=%s real=%s",
                tok["path"], cool_ts, _iso(meta["mtime"]),
            )
            return JSONResponse(status_code=409, content={"COOLStatusCode": 1010})

    # Read with a cap: this route is public (token in the query), an unbounded
    # body would let a leaked token fill the API's memory.
    body = b""
    async for chunk in request.stream():
        body += chunk
        if len(body) > _PUT_MAX_BYTES:
            raise HTTPException(status_code=413, detail="Datei zu groß")
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.put(
            _webdav_url(nc_user, tok["path"]),
            headers={**_auth_header(nc_user, nc_pass),
                     "Content-Type": "application/octet-stream"},
            content=body,
        )
    if resp.status_code not in (200, 201, 204):
        raise HTTPException(status_code=502, detail=f"Nextcloud PUT {resp.status_code}")

    meta = await _propfind_meta(nc_user, nc_pass, tok["path"])
    logger.info("wopi PutFile %s (%d bytes) von %s", tok["path"], len(body), tok["username"])
    return JSONResponse(content={"LastModifiedTime": _iso(meta["mtime"])})


@router.post("/files/{file_id}")
async def wopi_file_ops(file_id: str, request: Request) -> Response:
    """Lock/Unlock/RefreshLock/GetLock as no-ops (SupportsLocks: false)."""
    await _resolve_token(file_id, request.query_params.get("access_token", ""))
    return Response(status_code=200)
