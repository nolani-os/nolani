"""Downloads of a personal browser go into its owner's Files — with a narrow key.

A streamed browser container runs a full browser for one person. It must not hold the
API's service token: that token may act as ANY user, administrators included. Instead
every browser gets a key that is bound to ONE user and allows ONE thing — putting a file
into that user's download folder. It cannot read, list or delete anything.

    key = "<user>.<hex>"   hex = HMAC-SHA256(derived, user)
    derived = SHA-256("browser-upload-v1:" + service token)

The key is derived, not stored: no new secret to keep, and a leaked browser key reveals
nothing about the service token. Rotating the service token rotates all browser keys.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re

import httpx
from fastapi import APIRouter, File, HTTPException, Request, UploadFile

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/browser-ablage", tags=["browser"])

FOLDER = "/Downloads/Clara Browser"
MAX_SIZE = 10 * 1024 * 1024            # same cap as the relay
USER_RE = re.compile(r"^[a-z][a-z0-9._-]{1,31}$")


def _derived() -> bytes:
    token = os.environ.get("CLARAOS_SERVICE_TOKEN", "").strip()
    if not token:
        return b""
    return hashlib.sha256(b"browser-upload-v1:" + token.encode()).digest()


def key_for(user: str) -> str:
    """The upload key of `user`'s browser (provisioning calls this)."""
    d = _derived()
    if not d or not USER_RE.match(user or ""):
        raise ValueError("kein Schlüssel ableitbar")
    return f"{user}.{hmac.new(d, user.encode(), hashlib.sha256).hexdigest()}"


def user_from(key: str) -> str | None:
    """The user a key belongs to, or None (constant-time comparison)."""
    # The user part may itself contain dots: the signature is the LAST segment.
    user, _, _ = (key or "").rpartition(".")
    if not USER_RE.match(user):
        return None
    try:
        return user if hmac.compare_digest(key_for(user), key) else None
    except ValueError:
        return None


def _safe_name(name: str) -> str:
    """Just a file name: no path, no control characters, not empty."""
    name = os.path.basename((name or "").replace("\\", "/"))
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip().lstrip(".")
    return name[:200] or "download"


@router.post("/upload")
async def upload(request: Request, file: UploadFile = File(...)) -> dict:
    user = user_from(request.headers.get("X-Browser-Upload-Key", ""))
    if not user:
        raise HTTPException(status_code=401, detail="Ungültiger Browser-Schlüssel.")
    content = await file.read()
    if len(content) > MAX_SIZE:
        raise HTTPException(status_code=413, detail="Datei zu groß.")
    name = _safe_name(file.filename)

    # Same Nextcloud path as the Files app, as THIS user (own app password).
    from routers.files_v2 import _auth_header, _nc_credentials, _webdav_url
    nc_user, nc_pass = await _nc_credentials(user)
    auth = _auth_header(nc_user, nc_pass)
    async with httpx.AsyncClient(timeout=60.0) as client:
        acc = ""
        for part in FOLDER.strip("/").split("/"):   # MKCOL creates no parents
            acc += "/" + part
            await client.request("MKCOL", _webdav_url(nc_user, acc), headers=auth)
        resp = await client.put(_webdav_url(nc_user, f"{FOLDER}/{name}"),
                                headers={**auth, "Content-Type": file.content_type
                                         or "application/octet-stream"},
                                content=content)
    if resp.status_code not in (200, 201, 204):
        raise HTTPException(status_code=502, detail=f"Nextcloud: {resp.status_code}")
    logger.info("BROWSER-ABLAGE %s: %s (%d Bytes)", user, name, len(content))
    return {"ok": True, "path": f"{FOLDER}/{name}", "size": len(content)}
