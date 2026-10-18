"""Wallpaper and avatar storage.

Both are images that belong to the account and should outlive devices, so
they live in Nextcloud (`ClaraOS/Wallpapers`, `ClaraOS/Avatar`), not in
IndexedDB. A wallpaper that exists on only one laptop is not a personalized
account.

They are served through this router instead of a Nextcloud link, so the
images use the same sign-in path as the rest of the UI (the NC vhost
requires a session for browser access anyway).

Avatar model follows kcm_users: custom image, gallery, or initials with a
color. The initials case needs no file and is the default.
"""

from __future__ import annotations

import hashlib
import logging
import unicodedata

import httpx
from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import Response

from auth import get_current_user
from routers.files import _auth_header, _nc_credentials, _webdav_url

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/personalization", tags=["personalization"])

WALLPAPER_DIR = "ClaraOS/Wallpapers"
AVATAR_PATH = "ClaraOS/Avatar/avatar.png"
MAX_IMAGE_BYTES = 8 * 1024 * 1024
ALLOWED_TYPES = {"image/png", "image/jpeg", "image/webp", "image/avif"}

# Color palette for initials avatars (KDE pattern: color + matching text color).
INITIAL_COLORS = [
    ("#e93a9a", False), ("#e93d58", False), ("#e9643a", False),
    ("#e8cb2d", True), ("#3dd425", True), ("#00d3b8", True),
    ("#3daee9", True), ("#b875dc", False), ("#926ee4", False),
    ("#686b6f", False),
]


def _initials(name: str) -> str:
    """Initials as in kcm_users: NFD-normalized, first and last name."""
    clean = unicodedata.normalize("NFD", (name or "").strip())
    clean = "".join(c for c in clean if not unicodedata.combining(c))
    parts = [p for p in clean.split() if p]
    if not parts:
        return "?"
    if len(parts) == 1:
        return parts[0][0].upper()
    return (parts[0][0] + parts[-1][0]).upper()


async def _mkcol(client: httpx.AsyncClient, nc_user: str, nc_pass: str, folder: str) -> None:
    await client.request("MKCOL", _webdav_url(nc_user, f"/{folder}"),
                         headers=_auth_header(nc_user, nc_pass))


@router.get("/avatar/fallback")
async def avatar_fallback(request: Request) -> dict:
    """Initials and color, without a file, derived deterministically from the name.

    Deterministic means the same person gets the same color everywhere,
    even on a fresh device.
    """
    user = get_current_user(request)
    name = user.get("name") or user.get("username") or "?"
    digest = hashlib.sha1(name.encode("utf-8")).digest()
    color, dark_text = INITIAL_COLORS[digest[0] % len(INITIAL_COLORS)]

    # Whether a custom image exists belongs in the same response; otherwise the
    # client would have to download the image just to check that it exists.
    has_custom = False
    try:
        nc_user, nc_pass = await _nc_credentials(user["username"])
        async with httpx.AsyncClient(timeout=10.0) as client:
            probe = await client.request(
                "PROPFIND", _webdav_url(nc_user, f"/{AVATAR_PATH}"),
                headers={**_auth_header(nc_user, nc_pass), "Depth": "0"},
            )
        has_custom = probe.status_code < 400
    except Exception as exc:
        logger.debug("avatar probe failed for %s: %s", user.get("username"), exc)

    return {
        "initials": _initials(name),
        "color": color,
        "textColor": "#000000" if dark_text else "#ffffff",
        "hasCustom": has_custom,
    }


@router.get("/avatar")
async def get_avatar(request: Request) -> Response:
    """Serve the custom avatar image; 404 if none is stored."""
    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(_webdav_url(nc_user, f"/{AVATAR_PATH}"),
                             headers=_auth_header(nc_user, nc_pass))
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail="Kein Avatar hinterlegt.")
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Nextcloud: {r.status_code}")
    return Response(
        content=r.content,
        media_type=r.headers.get("Content-Type", "image/png"),
        # Cache briefly: the client appends a version to the URL, and a long
        # cache would swallow the update after an upload.
        headers={"Cache-Control": "private, max-age=60"},
    )


@router.post("/avatar")
async def put_avatar(request: Request, file: UploadFile = File(...)) -> dict:
    user = get_current_user(request)
    data = await file.read()
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Bild ist zu groß (max. 8 MB).")
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=415, detail=f"Format nicht unterstützt: {file.content_type}")

    nc_user, nc_pass = await _nc_credentials(user["username"])
    async with httpx.AsyncClient(timeout=30.0) as client:
        await _mkcol(client, nc_user, nc_pass, "ClaraOS")
        await _mkcol(client, nc_user, nc_pass, "ClaraOS/Avatar")
        r = await client.put(
            _webdav_url(nc_user, f"/{AVATAR_PATH}"),
            headers={**_auth_header(nc_user, nc_pass),
                     "Content-Type": file.content_type or "image/png"},
            content=data,
        )
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Nextcloud: {r.status_code}")
    return {"status": "ok"}


@router.delete("/avatar")
async def delete_avatar(request: Request) -> dict:
    """Remove the custom image; the initials apply again afterwards."""
    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])
    async with httpx.AsyncClient(timeout=20.0) as client:
        await client.delete(_webdav_url(nc_user, f"/{AVATAR_PATH}"),
                            headers=_auth_header(nc_user, nc_pass))
    return {"status": "ok"}


@router.get("/wallpapers")
async def list_wallpapers(request: Request) -> dict:
    """List the user's own wallpapers."""
    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])
    body = (
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>'
        "<d:resourcetype/><d:getcontenttype/><d:getcontentlength/>"
        "</d:prop></d:propfind>"
    )
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.request(
            "PROPFIND", _webdav_url(nc_user, f"/{WALLPAPER_DIR}"),
            headers={**_auth_header(nc_user, nc_pass), "Depth": "1",
                     "Content-Type": "application/xml"},
            content=body,
        )
    if r.status_code == 404:
        return {"wallpapers": []}
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Nextcloud: {r.status_code}")

    from routers.files import _parse_propfind
    items = _parse_propfind(r.content, nc_user, f"/{WALLPAPER_DIR}")
    names = [
        i["name"] for i in items
        if not i.get("isDir")
        and i["name"].lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".avif"))
    ]
    return {"wallpapers": [{"name": n, "url": f"/api/claraos/personalization/wallpaper/{n}"}
                           for n in sorted(names)]}


@router.get("/wallpaper/{name}")
async def get_wallpaper(name: str, request: Request) -> Response:
    user = get_current_user(request)
    if "/" in name or ".." in name:
        raise HTTPException(status_code=400, detail="Ungültiger Name.")
    nc_user, nc_pass = await _nc_credentials(user["username"])
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(_webdav_url(nc_user, f"/{WALLPAPER_DIR}/{name}"),
                             headers=_auth_header(nc_user, nc_pass))
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail="Nicht gefunden.")
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Nextcloud: {r.status_code}")
    return Response(content=r.content,
                    media_type=r.headers.get("Content-Type", "image/jpeg"),
                    headers={"Cache-Control": "private, max-age=3600"})


@router.post("/wallpaper")
async def upload_wallpaper(request: Request, file: UploadFile = File(...)) -> dict:
    user = get_current_user(request)
    data = await file.read()
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Bild ist zu groß (max. 8 MB).")
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=415, detail=f"Format nicht unterstützt: {file.content_type}")
    name = (file.filename or "wallpaper.jpg").replace("/", "_").replace("..", "_")[:120]

    nc_user, nc_pass = await _nc_credentials(user["username"])
    async with httpx.AsyncClient(timeout=60.0) as client:
        await _mkcol(client, nc_user, nc_pass, "ClaraOS")
        await _mkcol(client, nc_user, nc_pass, WALLPAPER_DIR)
        r = await client.put(
            _webdav_url(nc_user, f"/{WALLPAPER_DIR}/{name}"),
            headers={**_auth_header(nc_user, nc_pass),
                     "Content-Type": file.content_type or "image/jpeg"},
            content=data,
        )
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Nextcloud: {r.status_code}")
    return {"status": "ok", "name": name,
            "url": f"/api/claraos/personalization/wallpaper/{name}"}


@router.delete("/wallpaper/{name}")
async def delete_wallpaper(name: str, request: Request) -> dict:
    user = get_current_user(request)
    if "/" in name or ".." in name:
        raise HTTPException(status_code=400, detail="Ungültiger Name.")
    nc_user, nc_pass = await _nc_credentials(user["username"])
    async with httpx.AsyncClient(timeout=20.0) as client:
        await client.delete(_webdav_url(nc_user, f"/{WALLPAPER_DIR}/{name}"),
                            headers=_auth_header(nc_user, nc_pass))
    return {"status": "ok"}
