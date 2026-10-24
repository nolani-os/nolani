"""File system endpoints backed by Nextcloud WebDAV.

Replaces the local-filesystem backend with Nextcloud WebDAV so that every
user's files live in their Nextcloud account.  Group Folders appear
automatically (Nextcloud mounts them into the user's DAV tree).
"""

from betriebsprofil import IS_CELL, PRODUCT_NAME, heim_default  # external deployment: no silent home-server fallback
import base64
import logging
import os
import xml.etree.ElementTree as ET
from urllib.parse import quote as urlquote, unquote as urlunquote

import httpx
from fastapi import APIRouter, Request, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from auth import get_current_user
from database import user_tx
from encryption import decrypt_credentials

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/files", tags=["files"])

NEXTCLOUD_INTERNAL_URL = heim_default("NEXTCLOUD_URL")
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB (raised from 2 MB)

# ── Helpers ─────────────────────────────────────────────────────────


async def nc_zugang(username: str) -> str:
    """Does this user have Nextcloud access, and of what kind?

    Returns `eigen` (own credentials) | `dienstkonto` (service account) |
    `keiner` (none). Only checks existence, never touches the password.

    Important: `/files/v2/sources` used to report a hard-coded
    `connected: true` for the Nextcloud source, even for users whose file
    requests fail with 401 because no credentials are stored. The Files app
    then showed "connected" and nothing worked. A status indicator that does
    not reflect reality is worse than none: it sends users looking where there
    is nothing to find.
    """
    da = None
    if username:
        async with user_tx(username) as conn:   # row-level security (migrations/042)
            da = await conn.fetchval(
                "SELECT 1 FROM claraos_app_credentials "
                "WHERE username = $1 AND app_id = 'nextcloud' AND is_active = TRUE",
                username,
            )
    if da:
        return "eigen"
    if os.environ.get("NEXTCLOUD_SERVICE_USER") and os.environ.get("NEXTCLOUD_SERVICE_PASS"):
        return "dienstkonto"
    return "keiner"


async def _nc_credentials(username: str) -> tuple[str, str]:
    """Return (nc_username, nc_password) for the given ClaraOS user.

    Looks up stored Nextcloud credentials in the app_credentials table.
    Falls back to NEXTCLOUD_SERVICE_* env vars (service-account mode).
    """
    row = None
    if username:
        async with user_tx(username) as conn:   # row-level security (migrations/042)
            row = await conn.fetchrow(
                """
                SELECT credentials FROM claraos_app_credentials
                WHERE username = $1 AND app_id = 'nextcloud' AND is_active = TRUE
                """,
                username,
            )
    if row:
        creds = decrypt_credentials(row["credentials"])
        return creds.get("username", username), creds.get("password", "")

    # Fallback: service account (admin-level access, should only be used
    # for testing or migration). Never in a cell: every user without their own
    # credentials would share this one account and see the same files.
    svc_user = os.environ.get("NEXTCLOUD_SERVICE_USER", "")
    svc_pass = os.environ.get("NEXTCLOUD_SERVICE_PASS", "")
    if svc_user and svc_pass and not IS_CELL:
        return svc_user, svc_pass

    # Warning: 424, not 401. A user WITHOUT stored Nextcloud credentials used to
    # get 401 here, and `sessionGuard.ts` treats 401 as "the session is dead".
    # Result: a silent re-login followed by a reload of the entire shell,
    # triggered merely by a missing app connection.
    # Important: the user IS logged in; what is missing is a precondition. That
    # is exactly what 424 is for, and the frontend already maps it to "not
    # connected" (planner/api.ts -> NotConnectedError). Affects ~40 callers in
    # files/files_v2/bilder/contacts/planner, all of which mean the same thing.
    raise HTTPException(
        status_code=424,
        detail=f"No Nextcloud credentials found. Please save your Nextcloud credentials in {PRODUCT_NAME} Settings.",
    )


def _webdav_url(nc_user: str, path: str = "/") -> str:
    """Build the full WebDAV URL for a user path."""
    path = path.strip("/")
    segments = path.split("/") if path else []
    # ".."/"." would be normalised by the HTTP client and leave the user's
    # WebDAV root for other Nextcloud endpoints.
    if any(s in ("", ".", "..") for s in segments):
        raise HTTPException(status_code=400, detail="Ungültiger Pfad")
    encoded = "/".join(urlquote(s, safe="") for s in segments)
    base = f"{NEXTCLOUD_INTERNAL_URL}/remote.php/dav/files/{urlquote(nc_user, safe='')}"
    return f"{base}/{encoded}" if encoded else base


def _auth_header(nc_user: str, nc_pass: str) -> dict:
    """Return Basic-Auth header dict."""
    b64 = base64.b64encode(f"{nc_user}:{nc_pass}".encode()).decode()
    return {"Authorization": f"Basic {b64}"}


async def _ensure_desktop_folder(nc_user: str, nc_pass: str) -> None:
    """Idempotent MKCOL on /Desktop for the given Nextcloud user.

    201 Created and 405 Method Not Allowed (already-exists) both count as
    success. Any other status is logged but not raised — callers will see
    the original 404 if creation truly failed.
    """
    url = _webdav_url(nc_user, "/Desktop")
    headers = _auth_header(nc_user, nc_pass)
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.request("MKCOL", url, headers=headers)
        if resp.status_code not in (201, 405):
            logger.warning(
                "ensure_desktop MKCOL %s → %s: %s",
                nc_user, resp.status_code, resp.text[:200],
            )
    except Exception as e:  # noqa: BLE001
        logger.warning("ensure_desktop %s failed: %s", nc_user, e)


def _strip_dav_prefix(href: str, nc_user: str) -> str:
    """Convert a DAV href to a user-relative path."""
    prefix = f"/remote.php/dav/files/{urlquote(nc_user, safe='')}/"
    decoded = urlunquote(href)
    if decoded.startswith(prefix):
        return "/" + decoded[len(prefix):].rstrip("/")
    # Fallback: try without URL encoding
    prefix_plain = f"/remote.php/dav/files/{nc_user}/"
    if decoded.startswith(prefix_plain):
        return "/" + decoded[len(prefix_plain):].rstrip("/")
    return "/" + decoded.rstrip("/")


_DAV_NS = "DAV:"
_OC_NS = "http://owncloud.org/ns"


def _parse_propfind(xml_bytes: bytes, nc_user: str, base_path: str) -> list[dict]:
    """Parse a PROPFIND multistatus response into FileNode dicts."""
    root = ET.fromstring(xml_bytes)
    items = []
    for response in root.findall(f"{{{_DAV_NS}}}response"):
        href_el = response.find(f"{{{_DAV_NS}}}href")
        if href_el is None:
            continue
        href = href_el.text or ""
        rel_path = _strip_dav_prefix(href, nc_user)

        # Skip the directory itself. The comparison is normalized: hrefs come WITH
        # a leading '/', callers sometimes pass base without one (otherwise the
        # folder lists itself as a child and a walk collects everything twice).
        if "/" + rel_path.strip("/") == "/" + base_path.strip("/"):
            continue

        propstat = response.find(f"{{{_DAV_NS}}}propstat")
        if propstat is None:
            continue
        prop = propstat.find(f"{{{_DAV_NS}}}prop")
        if prop is None:
            continue

        resource_type = prop.find(f"{{{_DAV_NS}}}resourcetype")
        is_dir = (
            resource_type is not None
            and resource_type.find(f"{{{_DAV_NS}}}collection") is not None
        )

        name = rel_path.rstrip("/").rsplit("/", 1)[-1] if "/" in rel_path else rel_path.strip("/")

        node: dict = {
            "name": urlunquote(name),
            "path": rel_path,
            "isDir": is_dir,
        }

        if not is_dir:
            size_el = prop.find(f"{{{_DAV_NS}}}getcontentlength")
            if size_el is not None and size_el.text:
                node["size"] = int(size_el.text)

            modified_el = prop.find(f"{{{_DAV_NS}}}getlastmodified")
            if modified_el is not None and modified_el.text:
                node["modified"] = modified_el.text

        items.append(node)

    # Sort: directories first, then by name
    items.sort(key=lambda n: (not n["isDir"], n["name"].lower()))
    return items


# ── Endpoints ───────────────────────────────────────────────────────


@router.get("/tree")
async def file_tree(request: Request, path: str = "/", depth: int = 2) -> dict:
    """Get directory listing from the user's Nextcloud.

    Group Folders (Engineering, Marketing, etc.) appear automatically
    because Nextcloud mounts them into the user's DAV namespace.
    """
    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])

    url = _webdav_url(nc_user, path)
    headers = {
        **_auth_header(nc_user, nc_pass),
        "Depth": "1",
        "Content-Type": "application/xml",
    }
    propfind_body = """<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getlastmodified/>
    <d:displayname/>
  </d:prop>
</d:propfind>"""

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.request("PROPFIND", url, headers=headers, content=propfind_body)

    # Lazy-create /Desktop on first access for any user that doesn't have it yet.
    if resp.status_code == 404 and path.strip("/").split("/")[0:1] == ["Desktop"]:
        await _ensure_desktop_folder(nc_user, nc_pass)
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.request("PROPFIND", url, headers=headers, content=propfind_body)

    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="Path not found")
    if resp.status_code not in (200, 207):
        logger.error("PROPFIND %s → %s: %s", path, resp.status_code, resp.text[:300])
        raise HTTPException(status_code=502, detail=f"Nextcloud error: {resp.status_code}")

    children = _parse_propfind(resp.content, nc_user, path)

    # If depth > 1, recursively fetch children that are directories
    if depth > 1:
        for child in children:
            if child["isDir"]:
                try:
                    sub_url = _webdav_url(nc_user, child["path"])
                    async with httpx.AsyncClient(timeout=15.0) as sub_client:
                        sr = await sub_client.request(
                            "PROPFIND", sub_url, headers=headers, content=propfind_body
                        )
                    if sr.status_code in (200, 207):
                        child["children"] = _parse_propfind(sr.content, nc_user, child["path"])
                except Exception:
                    child["children"] = []

    # Build root node
    dir_name = path.rstrip("/").rsplit("/", 1)[-1] if "/" in path.strip("/") else "Home"
    return {
        "name": dir_name,
        "path": path,
        "isDir": True,
        "children": children,
    }


@router.get("/read")
async def read_file(request: Request, path: str = "") -> dict:
    """Read a file from the user's Nextcloud via WebDAV GET."""
    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])

    url = _webdav_url(nc_user, path)
    headers = _auth_header(nc_user, nc_pass)

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(url, headers=headers)

    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="File not found")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Nextcloud error: {resp.status_code}")

    if len(resp.content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail=f"File too large (max {MAX_FILE_SIZE // 1024 // 1024}MB)")

    # Try text decoding, fall back to base64 for binary
    try:
        content = resp.content.decode("utf-8")
        return {"path": path, "content": content, "size": len(resp.content), "encoding": "utf-8"}
    except UnicodeDecodeError:
        content_b64 = base64.b64encode(resp.content).decode()
        return {"path": path, "content": content_b64, "size": len(resp.content), "encoding": "base64"}


class _WriteRequest(BaseModel):
    path: str
    content: str


@router.post("/write")
async def write_file(request: Request, body: _WriteRequest) -> dict:
    """Write a text file to the user's Nextcloud via WebDAV PUT."""
    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])

    content_bytes = body.content.encode("utf-8")
    if len(content_bytes) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail=f"Content too large (max {MAX_FILE_SIZE // 1024 // 1024}MB)")

    url = _webdav_url(nc_user, body.path)
    headers = {
        **_auth_header(nc_user, nc_pass),
        "Content-Type": "application/octet-stream",
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.put(url, headers=headers, content=content_bytes)

    if resp.status_code not in (200, 201, 204):
        logger.error("PUT %s → %s: %s", body.path, resp.status_code, resp.text[:300])
        raise HTTPException(status_code=502, detail=f"Nextcloud error: {resp.status_code}")

    return {"path": body.path, "size": len(content_bytes), "ok": True}


@router.post("/mkdir")
async def make_directory(request: Request, path: str = "") -> dict:
    """Create a directory in the user's Nextcloud via WebDAV MKCOL."""
    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])

    url = _webdav_url(nc_user, path)
    headers = _auth_header(nc_user, nc_pass)

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.request("MKCOL", url, headers=headers)

    if resp.status_code == 405:
        return {"path": path, "ok": True, "existed": True}
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=f"Nextcloud error: {resp.status_code}")

    return {"path": path, "ok": True, "existed": False}


@router.delete("/delete")
async def delete_item(request: Request, path: str = "") -> dict:
    """Delete a file or directory from the user's Nextcloud via WebDAV DELETE."""
    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])

    if not path or path == "/":
        raise HTTPException(status_code=400, detail="Cannot delete root directory")

    url = _webdav_url(nc_user, path)
    headers = _auth_header(nc_user, nc_pass)

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.delete(url, headers=headers)

    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="Not found")
    if resp.status_code not in (200, 204):
        raise HTTPException(status_code=502, detail=f"Nextcloud error: {resp.status_code}")

    return {"path": path, "ok": True}


@router.post("/upload")
async def upload_file(
    request: Request,
    path: str = "/",
    file: UploadFile = File(...),
) -> dict:
    """Upload a binary file to the user's Nextcloud via WebDAV PUT."""
    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])

    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail=f"File too large (max {MAX_FILE_SIZE // 1024 // 1024}MB)")

    file_path = path.rstrip("/") + "/" + file.filename if path != "/" else "/" + file.filename
    url = _webdav_url(nc_user, file_path)
    headers = {
        **_auth_header(nc_user, nc_pass),
        "Content-Type": file.content_type or "application/octet-stream",
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.put(url, headers=headers, content=content)

    if resp.status_code not in (200, 201, 204):
        raise HTTPException(status_code=502, detail=f"Nextcloud error: {resp.status_code}")

    return {"path": file_path, "size": len(content), "filename": file.filename, "ok": True}


@router.get("/download")
async def download_file(request: Request, path: str = "") -> dict:
    """Download a file from the user's Nextcloud (returns base64 content + metadata)."""
    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])

    url = _webdav_url(nc_user, path)
    headers = _auth_header(nc_user, nc_pass)

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.get(url, headers=headers)

    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="File not found")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Nextcloud error: {resp.status_code}")

    filename = path.rstrip("/").rsplit("/", 1)[-1] if "/" in path else path.strip("/")
    content_b64 = base64.b64encode(resp.content).decode()

    return {
        "path": path,
        "filename": filename,
        "content": content_b64,
        "size": len(resp.content),
        "contentType": resp.headers.get("content-type", "application/octet-stream"),
    }


@router.get("/raw")
async def raw_file(request: Request, path: str = ""):
    """Stream a file through unchanged, without Base64 and without a size limit.

    Why in addition to /read and /download: both return Base64 inside a JSON
    response. That inflates the transfer by a third and forces the browser to
    hold the file twice in memory (text + decoded). For large binaries
    (Gaussian splat scenes easily reach 30 MB and more) that is the difference
    between working and crashing on a phone. /read also has a hard 10 MB limit.

    Purely additive: existing endpoints are unaffected.
    """
    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])

    url = _webdav_url(nc_user, path)
    headers = _auth_header(nc_user, nc_pass)
    client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=300.0))

    try:
        req = client.build_request("GET", url, headers=headers)
        resp = await client.send(req, stream=True)
    except Exception:
        await client.aclose()
        raise HTTPException(status_code=502, detail="Nextcloud nicht erreichbar")

    if resp.status_code != 200:
        code = resp.status_code
        await resp.aclose()
        await client.aclose()
        if code == 404:
            raise HTTPException(status_code=404, detail="File not found")
        raise HTTPException(status_code=502, detail=f"Nextcloud error: {code}")

    async def body():
        try:
            async for chunk in resp.aiter_bytes(chunk_size=256 * 1024):
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    out_headers = {"Cache-Control": "private, max-age=300"}
    if "content-length" in resp.headers:
        out_headers["Content-Length"] = resp.headers["content-length"]

    return StreamingResponse(
        body(),
        media_type=resp.headers.get("content-type", "application/octet-stream"),
        headers=out_headers,
    )
