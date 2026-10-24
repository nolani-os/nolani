"""Widget data endpoints for the mobile homescreen.

Weather via Bright Sky (https://brightsky.dev) — the DWD open-data API:
free, no API key, CC BY 4.0. Hourly data is grouped per day
(daily grouping of hourly data into min/max + dominant icon + precipitation).

Auth: the route lives under /api/claraos/ and is therefore gated by the
Caddy/Authentik forward-auth like every other API route. Weather is not
user-specific, so no per-user resolution is needed here.
"""
from betriebsprofil import PRODUCT_NAME, heim_default  # external deployments: no silent home-server fallback
import logging
import os
import random
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote as urlquote

import certifi
import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response

from auth import get_current_user
from routers.files import (
    NEXTCLOUD_INTERNAL_URL,
    _auth_header,
    _nc_credentials,
    _parse_propfind,
)

log = logging.getLogger("claraos.widgets")

router = APIRouter(prefix="/api/claraos/widgets", tags=["widgets"])

BRIGHTSKY = "https://api.brightsky.dev"
# Default location: geographic centre of Germany; set WEATHER_LAT/WEATHER_LON.
LAT = float(heim_default("WEATHER_LAT") or "51.16")
LON = float(heim_default("WEATHER_LON") or "10.45")

_TTL = 900.0  # 15 min server-side cache
_cache: dict[str, tuple[float, dict]] = {}

# Bright Sky condition icon -> (emoji, German label)
ICON = {
    "clear-day": ("☀️", "sonnig"),
    "clear-night": ("🌙", "klar"),
    "partly-cloudy-day": ("⛅", "teils bewölkt"),
    "partly-cloudy-night": ("🌤️", "teils bewölkt"),
    "cloudy": ("☁️", "bewölkt"),
    "fog": ("🌫️", "neblig"),
    "wind": ("💨", "windig"),
    "rain": ("🌧️", "Regen"),
    "sleet": ("🌨️", "Schneeregen"),
    "snow": ("❄️", "Schnee"),
    "hail": ("🌩️", "Hagel"),
    "thunderstorm": ("⛈️", "Gewitter"),
}


@router.get("/weather")
async def weather(days: int = Query(6, ge=1, le=7)) -> dict:
    """Current conditions + daily forecast for the configured location."""
    key = f"{LAT},{LON},{days}"
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < _TTL:
        return hit[1]
    try:
        # The claraos-api image points SSL_CERT_FILE/REQUESTS_CA_BUNDLE at the
        # internal reverse-proxy root CA (for internal hosts). That bundle knows no
        # public CAs, so EXTERNAL https calls must verify against certifi.
        async with httpx.AsyncClient(timeout=10.0, verify=certifi.where()) as client:
            cur_resp = await client.get(
                f"{BRIGHTSKY}/current_weather", params={"lat": LAT, "lon": LON},
            )
            cur_resp.raise_for_status()
            cur = cur_resp.json()
            d0 = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            d1 = (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%d")
            fc_resp = await client.get(
                f"{BRIGHTSKY}/weather",
                params={"lat": LAT, "lon": LON, "date": d0, "last_date": d1},
            )
            fc_resp.raise_for_status()
            fc = fc_resp.json()
    except Exception as e:  # noqa: BLE001 — serve stale on any upstream failure
        if hit:
            log.warning("brightsky unavailable, serving stale cache: %s", e)
            return hit[1]
        raise HTTPException(status_code=502, detail=f"brightsky unavailable: {e}")

    w = cur.get("weather") or {}
    emoji, text = ICON.get(w.get("icon") or "", ("🌤️", w.get("icon") or ""))

    # Group hourly forecast into per-day min/max + dominant icon + precip sum.
    by_day: dict[str, list] = {}
    for h in fc.get("weather") or []:
        by_day.setdefault((h.get("timestamp") or "")[:10], []).append(h)
    daily = []
    for day, hours in sorted(by_day.items()):
        temps = [h["temperature"] for h in hours if h.get("temperature") is not None]
        if not temps:
            continue
        icons = [h["icon"] for h in hours if h.get("icon")]
        dom = max(set(icons), key=icons.count) if icons else ""
        d_emoji, d_text = ICON.get(dom, ("🌤️", dom))
        daily.append({
            "date": day,
            "min": round(min(temps), 1),
            "max": round(max(temps), 1),
            "icon": dom,
            "emoji": d_emoji,
            "text": d_text,
            "precip": round(sum(h.get("precipitation") or 0 for h in hours), 1),
        })

    out = {
        "location": {
            "lat": LAT,
            "lon": LON,
            "station": (cur.get("sources") or [{}])[0].get("station_name"),
        },
        "current": {
            "temperature": w.get("temperature"),
            "icon": w.get("icon"),
            "emoji": emoji,
            "text": text,
        },
        "daily": daily[: days + 1],  # today + `days` lookahead
    }
    _cache[key] = (now, out)
    return out


# ── Photo widget (Nextcloud source, per user) ────────────────────────────────
#
# List + preview for the desktop photo frame. Full originals (HEIC/JPG, often
# >5 MB) NEVER go to the client; the preview comes from Nextcloud's preview
# generator (core/preview.png) and is only passed through here.

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".bmp", ".avif"}
# Folder candidates when the widget has no folder configured (yet).
# The first candidate WITH images wins (empty default folders do not block);
# SofortUpload = Nextcloud mobile auto-upload (Camera/DCIM), Family = group folder.
PHOTO_FOLDER_CANDIDATES = (
    "Fotos", "Photos", "Bilder", "Pictures", "SofortUpload", "Family",
)

_PHOTO_SCAN_DIRS = 24     # max. subfolders visited per list call
_PHOTO_SCAN_DEPTH = 3     # max. recursion depth below the start folder
_photo_cache: dict[str, tuple[float, dict]] = {}
_PHOTO_TTL = 300.0        # 5 min, so new uploads show up promptly


def _is_image(name: str) -> bool:
    dot = name.rfind(".")
    return dot >= 0 and name[dot:].lower() in IMAGE_EXTS


async def _propfind_dir(client: httpx.AsyncClient, nc_user: str, nc_pass: str,
                        path: str) -> list[dict] | None:
    """PROPFIND Depth 1 on a folder. None on 404/error."""
    path = "/" + path.strip("/")
    segments = path.strip("/").split("/") if path.strip("/") else []
    encoded = "/".join(urlquote(s, safe="") for s in segments)
    url = f"{NEXTCLOUD_INTERNAL_URL}/remote.php/dav/files/{urlquote(nc_user, safe='')}"
    if encoded:
        url += f"/{encoded}"
    resp = await client.request(
        "PROPFIND", url,
        headers={**_auth_header(nc_user, nc_pass), "Depth": "1"},
    )
    if resp.status_code != 207:
        return None
    return _parse_propfind(resp.content, nc_user, path)


@router.get("/photos")
async def list_photos(request: Request, folder: str = "", limit: int = Query(80, ge=1, le=300)) -> dict:
    """Image paths from a Nextcloud folder (recursive, bounded).

    Without `folder`, common folder names are tried. Nextcloud's own
    Depth-infinity PROPFIND is disabled by default, so this does an iterative
    breadth-first search with Depth 1, capped by folder count and depth.
    """
    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])

    cache_key = f"{nc_user}:{folder}:{limit}"
    now = time.time()
    hit = _photo_cache.get(cache_key)
    if hit and now - hit[0] < _PHOTO_TTL:
        return hit[1]

    async def scan(client: httpx.AsyncClient, start: str) -> tuple[list[str], bool] | None:
        """BFS below `start`; None if the folder does not exist."""
        first = await _propfind_dir(client, nc_user, nc_pass, start)
        if first is None:
            return None
        photos: list[str] = []
        truncated = False
        queue: list[tuple[list[dict], int]] = [(first, 0)]
        dirs_visited = 1
        while queue:
            entries, depth = queue.pop(0)
            subdirs: list[str] = []
            for e in entries:
                if e["isDir"]:
                    subdirs.append(e["path"])
                elif _is_image(e["name"]):
                    photos.append(e["path"])
            if len(photos) >= limit:
                truncated = True
                break
            if depth >= _PHOTO_SCAN_DEPTH:
                continue
            for sub in subdirs:
                if dirs_visited >= _PHOTO_SCAN_DIRS:
                    truncated = True
                    break
                listing = await _propfind_dir(client, nc_user, nc_pass, sub)
                dirs_visited += 1
                if listing is not None:
                    queue.append((listing, depth + 1))
        return photos, truncated

    async with httpx.AsyncClient(timeout=20.0) as client:
        roots = [folder] if folder.strip("/") else list(PHOTO_FOLDER_CANDIDATES)
        # Auto mode: the first candidate WITH images wins; an existing but
        # empty folder (e.g. Nextcloud's default "Photos") does not block.
        root: str | None = None
        photos: list[str] = []
        truncated = False
        for cand in roots:
            res = await scan(client, cand)
            if res is None:
                continue
            if root is None:
                root, (photos, truncated) = cand, res
            if res[0]:
                root, (photos, truncated) = cand, res
                break
        if root is None:
            raise HTTPException(status_code=404, detail="Foto-Ordner nicht gefunden")

    random.shuffle(photos)
    out = {"folder": root, "photos": photos[:limit], "truncated": truncated}
    _photo_cache[cache_key] = (now, out)
    return out


# ── Immich (photo frame v3) ──────────────────────────────────────────────────
#
# Per-user access with the user's OWN Immich API key (claraos_app_credentials,
# app_id='immich', field 'api_token'; same pattern as the gateway/bridge, see
# clara_tools.py). The key never leaves the server; the browser only sees
# these proxy endpoints.

IMMICH_URL = heim_default("IMMICH_INTERNAL_URL")

_IMMICH_CONNECT_HINT = (
    "Kein Immich-Konto verbunden — in Immich unter Kontoeinstellungen → "
    f"API-Schlüssel einen Key erzeugen und in {PRODUCT_NAME} hinterlegen "
    "(App-Zugang 'immich', Feld 'api_token')."
)


async def _user_credentials(username: str, app_id: str) -> dict:
    """Decrypted per-user credentials from claraos_app_credentials ({} if none)."""
    from database import user_tx
    from encryption import decrypt_credentials

    if not username:
        return {}
    async with user_tx(username) as conn:   # row-level security (migrations/042)
        row = await conn.fetchrow(
            """
            SELECT credentials FROM claraos_app_credentials
            WHERE username = $1 AND app_id = $2 AND is_active = TRUE
            LIMIT 1
            """,
            username, app_id,
        )
    if not row:
        return {}
    return decrypt_credentials(row["credentials"]) or {}


async def _require_credential(username: str, app_id: str, key: str, hint: str) -> str:
    value = str((await _user_credentials(username, app_id)).get(key) or "").strip()
    if not value:
        raise HTTPException(status_code=409, detail=hint)
    return value


async def _immich_key(username: str) -> str:
    return await _require_credential(username, "immich", "api_token", _IMMICH_CONNECT_HINT)


def _immich_error(resp: httpx.Response) -> HTTPException:
    if resp.status_code in (401, 403):
        return HTTPException(status_code=409, detail="Immich-API-Key ungültig oder abgelaufen — neuen Key hinterlegen.")
    return HTTPException(status_code=502, detail=f"Immich: {resp.status_code}")


@router.get("/immich/albums")
async def immich_albums(request: Request) -> dict:
    """Albums of the logged-in user (for the album picker in the photo frame)."""
    user = get_current_user(request)
    key = await _immich_key(user["username"])
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(f"{IMMICH_URL}/api/albums", headers={"x-api-key": key})
    if resp.status_code != 200:
        raise _immich_error(resp)
    albums = sorted(
        (
            {
                "id": a.get("id"),
                "name": a.get("albumName") or "(ohne Namen)",
                "count": a.get("assetCount", 0),
            }
            for a in resp.json()
            if a.get("id")
        ),
        key=lambda a: a["name"].lower(),
    )
    return {"albums": albums}


@router.get("/immich/photos")
async def immich_photos(request: Request, albums: str = "",
                        limit: int = Query(150, ge=1, le=500)) -> dict:
    """Asset IDs for the slideshow: from selected albums or random from all."""
    user = get_current_user(request)
    key = await _immich_key(user["username"])
    photos: list[dict] = []
    async with httpx.AsyncClient(timeout=20.0) as client:
        album_ids = [a for a in (s.strip() for s in albums.split(",")) if a]
        if album_ids:
            for aid in album_ids[:12]:
                resp = await client.get(
                    f"{IMMICH_URL}/api/albums/{aid}", headers={"x-api-key": key},
                )
                if resp.status_code in (401, 403):
                    raise _immich_error(resp)
                if resp.status_code != 200:
                    continue  # a deleted/foreign album does not block the show
                name = resp.json().get("albumName") or ""
                # Immich v3: AlbumResponseDto no longer contains assets;
                # assets come from the search API (albumIds filter).
                resp = await client.post(
                    f"{IMMICH_URL}/api/search/metadata",
                    headers={"x-api-key": key},
                    json={"albumIds": [aid], "size": 500},
                )
                if resp.status_code != 200:
                    continue
                for asset in (resp.json().get("assets") or {}).get("items") or []:
                    if asset.get("id"):
                        photos.append({
                            "id": asset["id"],
                            "date": (asset.get("fileCreatedAt") or "")[:10],
                            "album": name,
                        })
        else:
            # Immich v3: GET /api/assets/random was removed -> POST /api/search/random.
            resp = await client.post(
                f"{IMMICH_URL}/api/search/random",
                json={"size": limit}, headers={"x-api-key": key},
            )
            if resp.status_code != 200:
                raise _immich_error(resp)
            photos = [
                {"id": a["id"], "date": (a.get("fileCreatedAt") or "")[:10], "album": ""}
                for a in resp.json() if a.get("id")
            ]
    random.shuffle(photos)
    return {"photos": photos[:limit]}


@router.get("/immich/thumb")
async def immich_thumb(request: Request, id: str, size: str = "preview") -> Response:
    """Thumbnail proxy: originals and the API key stay server-side."""
    if size not in ("thumbnail", "preview"):
        raise HTTPException(status_code=400, detail="size: thumbnail|preview")
    user = get_current_user(request)
    key = await _immich_key(user["username"])
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{IMMICH_URL}/api/assets/{id}/thumbnail",
            params={"size": size}, headers={"x-api-key": key},
        )
    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="Asset nicht gefunden")
    if resp.status_code != 200:
        raise _immich_error(resp)
    return Response(
        content=resp.content,
        media_type=resp.headers.get("content-type", "image/jpeg"),
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.get("/photo")
async def photo_preview(request: Request, path: str,
                        x: int = Query(1024, ge=64, le=2048),
                        y: int = Query(1024, ge=64, le=2048)) -> Response:
    """Preview image via the Nextcloud preview generator (per-user auth)."""
    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])
    url = (
        f"{NEXTCLOUD_INTERNAL_URL}/index.php/core/preview.png"
        f"?file={urlquote('/' + path.lstrip('/'), safe='')}&x={x}&y={y}&a=1"
    )
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(url, headers=_auth_header(nc_user, nc_pass))
    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="Keine Vorschau verfügbar")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Nextcloud preview: {resp.status_code}")
    return Response(
        content=resp.content,
        media_type=resp.headers.get("content-type", "image/png"),
        headers={"Cache-Control": "private, max-age=3600"},
    )
