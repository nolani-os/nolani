"""Unified file system API: Nextcloud WebDAV + SFTP sources.

Provides a single API for accessing files across multiple storage backends:
- Nextcloud (user's cloud files, group folders)
- SFTP (connected devices via Network Manager)
"""

import base64
import json as _json
import logging
from typing import Optional

from fastapi import APIRouter, Request, HTTPException, UploadFile, File
from pydantic import BaseModel

from auth import get_current_user
from sprache import Text, tx
from database import get_pool
import sftp_client

# SSH devices as file sources are installation-specific (services/geraete_heim.py:
# known devices, start paths, address resolution). Without that module the
# only source is Nextcloud.
try:
    from services import geraete_heim as _geraete
except ImportError:
    _geraete = None


def _known_devices() -> dict:
    return _geraete.known_devices() if _geraete is not None else {}


def _default_path_for(dev: dict) -> str:
    return _geraete.default_path_for(dev) if _geraete is not None else (dev.get("default_path") or "/")


async def _resolve_device(username: str, ip: str, dev: dict, *, force: bool = False) -> dict:
    if _geraete is None:
        return {"status": "offline", "host": None, "via": None, "last_seen": None}
    return await _geraete.resolve(username, ip, dev, force=force)

# Re-use existing Nextcloud helpers
from routers.files import (
    _nc_credentials, _webdav_url, _auth_header,
    _parse_propfind, _ensure_desktop_folder, nc_zugang,
    MAX_FILE_SIZE, NEXTCLOUD_INTERNAL_URL,
)
import httpx

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/files/v2", tags=["files-v2"])

# Shortcut-files use this suffix. Frontend strips it when rendering names.
SHORTCUT_SUFFIX = ".lnk.json"


async def _read_shortcut(client: httpx.AsyncClient, nc_user: str, nc_pass: str, path: str) -> dict | None:
    """Fetch and parse a .lnk.json shortcut file. Returns its parsed dict or None."""
    try:
        resp = await client.get(_webdav_url(nc_user, path), headers=_auth_header(nc_user, nc_pass))
        if resp.status_code != 200 or len(resp.content) > 4096:
            return None
        data = _json.loads(resp.content)
        if not isinstance(data, dict) or "target" not in data:
            return None
        return data
    except Exception:  # noqa: BLE001
        return None


async def _check_target_exists(client: httpx.AsyncClient, nc_user: str, nc_pass: str, target: str) -> bool:
    """Best-effort HEAD/PROPFIND on shortcut target to detect broken links."""
    try:
        resp = await client.request(
            "PROPFIND",
            _webdav_url(nc_user, target),
            headers={**_auth_header(nc_user, nc_pass), "Depth": "0"},
        )
        return resp.status_code in (200, 207)
    except Exception:  # noqa: BLE001
        return False


async def _decorate_shortcuts(children: list[dict], nc_user: str, nc_pass: str) -> None:
    """For each .lnk.json child: read content, attach shortcut metadata, strip suffix from name.

    Performs all reads in parallel and broken-checks in parallel. Adds:
      - node["isShortcut"] = True
      - node["shortcut"] = { target, type, icon?, broken }
      - node["name"] (with .lnk.json suffix stripped for display)
    """
    import asyncio

    shortcuts = [c for c in children if c["name"].endswith(SHORTCUT_SUFFIX) and not c.get("isDir")]
    if not shortcuts:
        return

    async with httpx.AsyncClient(timeout=10.0) as client:
        # Phase 1: read .lnk.json content (parallel)
        contents = await asyncio.gather(
            *[_read_shortcut(client, nc_user, nc_pass, c["path"]) for c in shortcuts]
        )
        # Phase 2: broken-check on targets (parallel) — only for valid shortcuts
        valid = [(c, data) for c, data in zip(shortcuts, contents) if data]
        existences = await asyncio.gather(
            *[_check_target_exists(client, nc_user, nc_pass, data["target"]) for _, data in valid]
        )

    exist_map = {id(c): exists for (c, _data), exists in zip(valid, existences)}

    for c, data in zip(shortcuts, contents):
        if not data:
            continue
        c["isShortcut"] = True
        c["shortcut"] = {
            "target": data.get("target"),
            "type": data.get("type", "shortcut"),
            "icon": data.get("icon"),
            "broken": not exist_map.get(id(c), False),
        }
        # Display name without suffix
        if c["name"].endswith(SHORTCUT_SUFFIX):
            c["name"] = c["name"][: -len(SHORTCUT_SUFFIX)]


# ── Source Resolution ──────────────────────────────────────


def _parse_source(source_id: str) -> dict:
    """Parse source ID into connection params.

    Returns dict with: type, host, port, user, key_path (for SFTP)
    or type="nextcloud" for Nextcloud sources.
    """
    if not source_id or source_id == "nextcloud":
        return {"type": "nextcloud"}

    if source_id.startswith("sftp:"):
        ip = source_id[5:]
        known = _known_devices().get(ip, {})
        return {
            "type": "sftp",
            "host": ip,
            # Source identity: source IDs ALWAYS stay sftp:<lan_ip>, even when
            # _reachable() switches the connection host to another address.
            "lan_ip": ip,
            "port": known.get("ssh_port", 22),
            "user": known.get("ssh_user", "root"),
            "key_path": known.get("key_path"),
            "hostname": known.get("hostname", ip),
            "os": known.get("os", "linux"),
            "default_path": _default_path_for(known),
            "fallback_path": known.get("fallback_path"),
            # Private device: only these users may see/reach it.
            "owner_users": known.get("owner_users"),
        }

    raise HTTPException(status_code=400, detail=f"Unknown source: {source_id}")


def _require_device_access(user: dict, src: dict) -> None:
    """Security: other machines are not a shared drive for every user.

    The SFTP sources are devices on the local network (servers, desktops,
    storage boxes, ...). They share a single key, and `_sftp_tree()` never
    sees the username. Without this check a non-admin user could read (and
    via write/upload/rename/delete/move also modify) e.g. another machine's
    system drive or root filesystem.

    As long as there are no per-user credentials, the only correct answer is:
    admins only. A user's own devices will later be connected through their
    own credentials, not through this shared key.
    """
    if src.get("type") != "sftp":
        return
    # Private devices (owner_users set) are ONLY for their owners —
    # deliberately WITHOUT an admin exception, so a private machine is also
    # protected from other admins/test accounts. Without owner_users the rule
    # above applies: home-network devices are admin-only.
    owners = src.get("owner_users")
    if owners is not None:
        if user.get("username") in owners:
            return
        raise HTTPException(
            status_code=403,
            detail={"code": "device_forbidden",
                    "message": Text("files.devicePrivate")},
        )
    if user.get("role") == "admin":
        return
    raise HTTPException(
        status_code=403,
        detail={"code": "device_forbidden",
                "message": Text("files.deviceAdmin")},
    )


async def _reachable(src: dict, user: dict) -> dict:
    """Rewrite an SFTP source to a reachable host.

    The installation's resolver probes the device's candidate addresses (LAN
    preferred). No candidate online → 503 device_offline with last_seen; the
    frontend error UI renders the offline state from that. The source ID stays
    stable as ``sftp:<lan_ip>``; only src["host"] may switch to another address.
    """
    if src.get("type") != "sftp":
        return src
    _require_device_access(user, src)
    res = await _resolve_device(
        user["username"], src["host"], _known_devices().get(src["host"], {}),
    )
    if res["status"] != "online":
        raise HTTPException(status_code=503, detail={
            "code": "device_offline",
            "status": res["status"],
            "device": src.get("hostname", src["host"]),
            "last_seen": res["last_seen"],
        })
    return {**src, "host": res["host"], "via": res["via"]}


# ── Endpoints ──────────────────────────────────────────────


_CONN_CACHE: dict[tuple[str, int], tuple[float, str]] = {}
_CONN_CACHE_TTL_S = 60.0


async def _probe_sftp_status(host: str, port: int, *, force: bool = False) -> str:
    """Best-effort TCP probe on the device's actual SSH port.

    'online'    - port open (sshd answers)
    'sshd_down' - host reachable but port refused (e.g. a phone without a running sshd)
    'offline'   - timeout / no route (device off or on another network)

    Cached for 60 s per (host, port); force=True for the retry button.
    """
    import asyncio
    import time as _time
    now = _time.time()
    cached = _CONN_CACHE.get((host, port))
    if not force and cached and (now - cached[0]) < _CONN_CACHE_TTL_S:
        return cached[1]
    try:
        fut = asyncio.open_connection(host, port)
        _reader, writer = await asyncio.wait_for(fut, timeout=1.5)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass
        status = "online"
    except ConnectionRefusedError:
        status = "sshd_down"
    except Exception:  # noqa: BLE001
        status = "offline"
    _CONN_CACHE[(host, port)] = (now, status)
    return status


@router.get("/sources")
async def list_sources(request: Request, refresh: int = 0) -> list[dict]:
    """List all available file sources for the current user."""
    import asyncio
    user = get_current_user(request)

    # Important: `connected` reflects whether the user has stored Nextcloud
    # credentials; without them every request ends in 401. `status` says WHY:
    # "no access" is different from "offline" — the user can fix the former
    # themselves, but not the latter.
    zugang = await nc_zugang(user["username"])
    sources = [
        {"id": "nextcloud", "name": "Nextcloud", "type": "nextcloud",
         "icon": "\u2601",
         "connected": zugang != "keiner",
         "status": "online" if zugang != "keiner" else "kein_zugang"},
    ]

    # Security: the device sources below are the home network and share a
    # single key — regular users have no business there. This is deliberately
    # in addition to the check in `_require_device_access()`: that one is the
    # authorization, this one keeps users from even seeing tiles that would
    # only return 403.
    # Visibility per device:
    #  - Devices with owner_users are private: ONLY the owner sees them (no
    #    other admin either), so "only me" really means only me.
    #  - Devices without owner_users are reserved for admins.
    # For non-admins without a private device of their own, the list ends at
    # Nextcloud.
    uname = user.get("username")
    is_admin = user.get("role") == "admin"
    devices = []
    for ip, dev in _known_devices().items():
        if not dev.get("ssh_user"):
            continue
        owners = dev.get("owner_users")
        if owners is not None:
            if uname in owners:
                devices.append((ip, dev))
        elif is_admin:
            devices.append((ip, dev))
    if not devices:
        return sources
    results = await asyncio.gather(*(
        _resolve_device(user["username"], ip, dev, force=bool(refresh))
        for ip, dev in devices
    ))
    for (ip, dev), res in zip(devices, results):
        sources.append({
            "id": f"sftp:{ip}",
            "name": dev.get("hostname", ip),
            "type": "sftp",
            "icon": _device_icon(dev.get("device_type", "unknown")),
            "host": ip,
            "connected": res["status"] == "online",
            "status": res["status"],
            "via": res["via"],
            "last_seen": res["last_seen"],
            "default_path": _default_path_for(dev),
            "os": dev.get("os", "linux"),
            "device_type": dev.get("device_type", "unknown"),
        })

    return sources


def _device_icon(dt: str) -> str:
    icons = {"server": "\U0001f5a5", "desktop": "\U0001f4bb", "mobile": "\U0001f4f1",
             "nas": "\U0001f4be", "printer": "\U0001f5a8"}
    return icons.get(dt, "\U0001f4e1")


@router.get("/tree")
async def file_tree(request: Request, source: str = "nextcloud",
                    path: str = "/", depth: int = 1) -> dict:
    """Get directory listing from any source."""
    user = get_current_user(request)
    src = _parse_source(source)

    if src["type"] == "nextcloud":
        return await _nc_tree(user["username"], path, depth)
    elif src["type"] == "sftp":
        src = await _reachable(src, user)
        return await _sftp_tree(src, path)

    raise HTTPException(status_code=400, detail="Invalid source type")


async def _nc_tree(username: str, path: str, depth: int) -> dict:
    """Nextcloud WebDAV tree (delegated from files.py logic)."""
    nc_user, nc_pass = await _nc_credentials(username)
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
        resp = await _dav_request(client, "PROPFIND", url, headers=headers, content=propfind_body)

    # Lazy-create /Desktop on first access for any user that doesn't have it yet.
    if resp.status_code == 404 and path.strip("/").split("/")[0:1] == ["Desktop"]:
        await _ensure_desktop_folder(nc_user, nc_pass)
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await _dav_request(client, "PROPFIND", url, headers=headers, content=propfind_body)

    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="Path not found")
    if resp.status_code not in (200, 207):
        raise HTTPException(status_code=502, detail=f"Nextcloud error: {resp.status_code}")

    children = _parse_propfind(resp.content, nc_user, path)
    # Tag children with source
    for c in children:
        c["source"] = "nextcloud"

    # Decorate any .lnk.json shortcut files with their target (parallel reads + broken-detection)
    await _decorate_shortcuts(children, nc_user, nc_pass)

    name = path.rstrip("/").rsplit("/", 1)[-1] if "/" in path.strip("/") else "Home"
    return {"name": name, "path": path, "isDir": True, "source": "nextcloud", "children": children}


async def _sftp_tree(src: dict, path: str) -> dict:
    """SFTP directory listing."""
    note: str | None = None
    try:
        children = await sftp_client.list_dir(
            src["host"], src["port"], src["user"], path, key_path=src.get("key_path"),
        )
        # Android: an empty /sdcard almost always means "the SSH server app has
        # no storage permission" (list_dir silently degrades permission errors to
        # an empty listing). Show the fallback (home) path instead, with a hint.
        if (not children and src.get("os") == "android"
                and path == src.get("default_path") and src.get("fallback_path")):
            fb = src["fallback_path"]
            fb_children = await sftp_client.list_dir(
                src["host"], src["port"], src["user"], fb, key_path=src.get("key_path"),
            )
            if fb_children:
                path, children = fb, fb_children
                note = (getattr(_geraete, "FALLBACK_HINWEIS", "")
                        or await tx("files.noSdcard"))
        source_id = f"sftp:{src.get('lan_ip', src['host'])}"
        for c in children:
            c["source"] = source_id
        name = path.rstrip("/").rsplit("/", 1)[-1] if "/" in path.strip("/") else src.get("hostname", src["host"])
        result = {"name": name, "path": path, "isDir": True, "source": source_id, "children": children}
        if note:
            result["note"] = note
        return result
    except Exception as e:
        logger.error("SFTP tree %s:%s failed: %s", src["host"], path, e)
        # Report connection errors honestly: device offline / sshd down is not an empty folder
        status = await _probe_sftp_status(src["host"], src["port"], force=True)
        if status != "online":
            raise HTTPException(status_code=503, detail={
                "code": "device_offline",
                "status": status,
                "device": src.get("hostname", src["host"]),
            })
        raise HTTPException(status_code=502, detail={
            "code": "sftp_error",
            "message": str(e),
            "device": src.get("hostname", src["host"]),
        })


@router.get("/read")
async def read_file(request: Request, source: str = "nextcloud", path: str = "") -> dict:
    """Read a file from any source."""
    user = get_current_user(request)
    src = _parse_source(source)

    if src["type"] == "nextcloud":
        nc_user, nc_pass = await _nc_credentials(user["username"])
        url = _webdav_url(nc_user, path)
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(url, headers=_auth_header(nc_user, nc_pass))
        if resp.status_code == 404:
            raise HTTPException(status_code=404, detail="File not found")
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Nextcloud error: {resp.status_code}")
        data = resp.content
    elif src["type"] == "sftp":
        src = await _reachable(src, user)
        try:
            data = await sftp_client.read_file(
                src["host"], src["port"], src["user"], path, key_path=src.get("key_path"),
            )
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"SFTP read error: {e}")
    else:
        raise HTTPException(status_code=400)

    if len(data) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large")

    try:
        content = data.decode("utf-8")
        return {"path": path, "source": source, "content": content, "size": len(data), "encoding": "utf-8"}
    except UnicodeDecodeError:
        return {"path": path, "source": source, "content": base64.b64encode(data).decode(),
                "size": len(data), "encoding": "base64"}


class _WriteBody(BaseModel):
    source: str = "nextcloud"
    path: str
    content: str
    encoding: str = "utf-8"  # "utf-8" | "base64" (binary templates: docx/png/…)


@router.post("/write")
async def write_file(request: Request, body: _WriteBody) -> dict:
    """Write a file to any source. encoding=base64 for binary content."""
    user = get_current_user(request)
    src = _parse_source(body.source)
    if body.encoding == "base64":
        try:
            content_bytes = base64.b64decode(body.content)
        except Exception:
            raise HTTPException(status_code=400, detail="invalid base64 content")
    else:
        content_bytes = body.content.encode("utf-8")

    if len(content_bytes) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="Content too large")

    if src["type"] == "nextcloud":
        nc_user, nc_pass = await _nc_credentials(user["username"])
        url = _webdav_url(nc_user, body.path)
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.put(url, headers={**_auth_header(nc_user, nc_pass),
                                                   "Content-Type": "application/octet-stream"},
                                    content=content_bytes)
        if resp.status_code not in (200, 201, 204):
            raise HTTPException(status_code=502, detail=f"Nextcloud error: {resp.status_code}")
    elif src["type"] == "sftp":
        src = await _reachable(src, user)
        await sftp_client.write_file(
            src["host"], src["port"], src["user"], body.path, content_bytes, key_path=src.get("key_path"),
        )

    return {"path": body.path, "source": body.source, "size": len(content_bytes), "ok": True}


@router.post("/mkdir")
async def make_directory(request: Request, source: str = "nextcloud", path: str = "") -> dict:
    """Create directory on any source."""
    user = get_current_user(request)
    src = _parse_source(source)

    if src["type"] == "nextcloud":
        nc_user, nc_pass = await _nc_credentials(user["username"])
        url = _webdav_url(nc_user, path)
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.request("MKCOL", url, headers=_auth_header(nc_user, nc_pass))
        if resp.status_code not in (200, 201, 405):
            raise HTTPException(status_code=502, detail=f"Nextcloud error: {resp.status_code}")
    elif src["type"] == "sftp":
        src = await _reachable(src, user)
        await sftp_client.mkdir(src["host"], src["port"], src["user"], path, key_path=src.get("key_path"))

    return {"path": path, "source": source, "ok": True}


@router.delete("/delete")
async def delete_item(request: Request, source: str = "nextcloud", path: str = "",
                      permanent: bool = False) -> dict:
    """Delete file/directory on any source.

    Nextcloud moves deleted items to the trash bin. permanent=1 additionally
    purges the trash entry afterwards, so "delete permanently" really does."""
    user = get_current_user(request)
    src = _parse_source(source)

    if not path or path == "/":
        raise HTTPException(status_code=400, detail="Cannot delete root")

    if src["type"] == "nextcloud":
        nc_user, nc_pass = await _nc_credentials(user["username"])
        url = _webdav_url(nc_user, path)
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.delete(url, headers=_auth_header(nc_user, nc_pass))
        if resp.status_code not in (200, 204):
            raise HTTPException(status_code=502, detail=f"Nextcloud error: {resp.status_code}")
        if permanent:
            purged = False
            for it in await list_trash(request):  # newest first
                if (it.get("originalPath") or "").strip("/") == path.strip("/"):
                    async with httpx.AsyncClient(timeout=30.0) as client:
                        r = await client.delete(_trash_url(nc_user, "trash", it["trashPath"]),
                                                headers=_auth_header(nc_user, nc_pass))
                    purged = r.status_code in (200, 204)
                    break
            return {"path": path, "source": source, "ok": True, "purged": purged}
    elif src["type"] == "sftp":
        src = await _reachable(src, user)
        await sftp_client.delete(src["host"], src["port"], src["user"], path, key_path=src.get("key_path"))

    return {"path": path, "source": source, "ok": True}


@router.post("/upload")
async def upload_file(
    request: Request,
    source: str = "nextcloud",
    path: str = "/",
    file: UploadFile = File(...),
) -> dict:
    """Upload file to any source."""
    user = get_current_user(request)
    src = _parse_source(source)
    content = await file.read()

    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large")

    file_path = path.rstrip("/") + "/" + file.filename

    if src["type"] == "nextcloud":
        nc_user, nc_pass = await _nc_credentials(user["username"])
        url = _webdav_url(nc_user, file_path)
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.put(url, headers={**_auth_header(nc_user, nc_pass),
                                                   "Content-Type": file.content_type or "application/octet-stream"},
                                    content=content)
        if resp.status_code not in (200, 201, 204):
            raise HTTPException(status_code=502, detail=f"Nextcloud error: {resp.status_code}")
    elif src["type"] == "sftp":
        src = await _reachable(src, user)
        await sftp_client.write_file(
            src["host"], src["port"], src["user"], file_path, content, key_path=src.get("key_path"),
        )

    return {"path": file_path, "source": source, "size": len(content), "ok": True}


class _RenameBody(BaseModel):
    source: str = "nextcloud"
    path: str
    new_name: str


@router.post("/rename")
async def rename_item(request: Request, body: _RenameBody) -> dict:
    """Rename a file or directory in-place (no path change beyond the leaf)."""
    user = get_current_user(request)
    src = _parse_source(body.source)

    if not body.path or body.path == "/":
        raise HTTPException(status_code=400, detail="Cannot rename root")
    if "/" in body.new_name or body.new_name in ("", ".", ".."):
        raise HTTPException(status_code=400, detail="Invalid new name")

    parent = body.path.rsplit("/", 1)[0] or "/"
    new_path = (parent.rstrip("/") + "/" + body.new_name) if parent != "/" else "/" + body.new_name

    if src["type"] == "nextcloud":
        nc_user, nc_pass = await _nc_credentials(user["username"])
        from_url = _webdav_url(nc_user, body.path)
        to_url = _webdav_url(nc_user, new_path)
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.request(
                "MOVE", from_url,
                headers={**_auth_header(nc_user, nc_pass), "Destination": to_url, "Overwrite": "F"},
            )
        if resp.status_code not in (201, 204):
            raise HTTPException(status_code=502, detail=f"Nextcloud rename error: {resp.status_code}")
    elif src["type"] == "sftp":
        src = await _reachable(src, user)
        await sftp_client.rename(
            src["host"], src["port"], src["user"], body.path, new_path, key_path=src.get("key_path"),
        )

    return {"path": new_path, "source": body.source, "ok": True}


# ── Copy / move ─────────────────────────────────────────────
#
# Warning: a naive GET+PUT copy breaks on folders — Nextcloud's GET on a
# FOLDER returns HTTP 200 with the "This is the WebDAV interface…" notice page,
# which would silently produce a tiny bogus "copy". Likewise `Overwrite: T`
# would silently replace any same-named target. Therefore:
#   * Folders are detected: Nextcloud→Nextcloud uses native WebDAV COPY
#     (recursive, server-side), otherwise recursive file by file.
#   * Conflicts are the user's decision: `on_conflict`
#     fail (default → 409) · overwrite · rename ("Name (2).ext") · skip.
#   * A copy into the same folder becomes "Name (Kopie).ext", never overwriting itself.

_CONFLICT_MODES = ("fail", "overwrite", "rename", "skip")


def _norm(path: str) -> str:
    return "/" + path.strip("/")


def _parent(path: str) -> str:
    return _norm(path).rsplit("/", 1)[0] or "/"


def _leaf(path: str) -> str:
    return _norm(path).rsplit("/", 1)[-1]


def _join(folder: str, name: str) -> str:
    return _norm(folder).rstrip("/") + "/" + name


def _same_backend(a: dict, b: dict) -> bool:
    if a["type"] != b["type"]:
        return False
    return a["type"] == "nextcloud" or a.get("lan_ip", a.get("host")) == b.get("lan_ip", b.get("host"))


def _candidate_names(name: str, is_dir: bool, same_folder: bool):
    """"Report.pdf" → "Report (Kopie).pdf", "Report (Kopie 2).pdf" … or
    "Report (2).pdf", "Report (3).pdf" … — the extension stays at the end."""
    stem, ext = name, ""
    if not is_dir:
        i = name.rfind(".")
        if i > 0:
            stem, ext = name[:i], name[i:]
    for n in range(1, 200):
        if same_folder:
            tag = " (Kopie)" if n == 1 else f" (Kopie {n})"
        else:
            tag = f" ({n + 1})"
        yield f"{stem}{tag}{ext}"


class _Backend:
    """Uniform access to Nextcloud or an SFTP device for ONE operation."""

    def __init__(self, src: dict, nc_user: str | None = None, nc_pass: str | None = None):
        self.src = src
        self.nc_user = nc_user
        self.nc_pass = nc_pass

    @classmethod
    async def open(cls, source_id: str, user: dict, *, write: bool = False) -> "_Backend":
        src = _parse_source(source_id)
        if src["type"] == "nextcloud":
            nc_user, nc_pass = await _nc_credentials(user["username"])
            return cls(src, nc_user, nc_pass)
        # Important: target devices also go through _reachable — that checks
        # access (_require_device_access) AND switches to a reachable host.
        return cls(await _reachable(src, user))

    @property
    def is_nc(self) -> bool:
        return self.src["type"] == "nextcloud"

    def _kw(self) -> dict:
        return {"key_path": self.src.get("key_path")}

    def _hpu(self) -> tuple:
        return self.src["host"], self.src["port"], self.src["user"]

    async def kind(self, path: str) -> str | None:
        """None = does not exist · 'dir' · 'file'."""
        if self.is_nc:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await _dav_request(
                    client, "PROPFIND", _webdav_url(self.nc_user, path),
                    headers={**_auth_header(self.nc_user, self.nc_pass), "Depth": "0",
                             "Content-Type": "application/xml"},
                    content='<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
                )
            if r.status_code == 404:
                return None
            if r.status_code not in (200, 207):
                raise HTTPException(status_code=502, detail=f"Nextcloud PROPFIND {r.status_code}")
            return "dir" if b"collection" in r.content else "file"
        return await sftp_client.kind(*self._hpu(), path, **self._kw())

    async def children(self, path: str) -> list[dict]:
        if self.is_nc:
            async with httpx.AsyncClient(timeout=30.0) as client:
                r = await _dav_request(
                    client, "PROPFIND", _webdav_url(self.nc_user, path),
                    headers={**_auth_header(self.nc_user, self.nc_pass), "Depth": "1",
                             "Content-Type": "application/xml"},
                    content='<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>',
                )
            if r.status_code not in (200, 207):
                raise HTTPException(status_code=502, detail=f"Nextcloud PROPFIND {r.status_code}")
            return _parse_propfind(r.content, self.nc_user, path)
        return await sftp_client.list_dir(*self._hpu(), path, **self._kw())

    async def read(self, path: str) -> bytes:
        if self.is_nc:
            async with httpx.AsyncClient(timeout=120.0) as client:
                r = await client.get(_webdav_url(self.nc_user, path),
                                     headers=_auth_header(self.nc_user, self.nc_pass))
            if r.status_code != 200:
                raise HTTPException(status_code=502, detail=Text("files.readFailed", status=r.status_code, name=_leaf(path)))
            return r.content
        return await sftp_client.read_file(*self._hpu(), path, **self._kw())

    async def write(self, path: str, data: bytes) -> None:
        if self.is_nc:
            async with httpx.AsyncClient(timeout=120.0) as client:
                r = await client.put(_webdav_url(self.nc_user, path),
                                     headers={**_auth_header(self.nc_user, self.nc_pass),
                                              "Content-Type": "application/octet-stream"},
                                     content=data)
            if r.status_code not in (200, 201, 204):
                raise HTTPException(status_code=502, detail=Text("files.writeFailed", status=r.status_code, name=_leaf(path)))
            return
        await sftp_client.write_file(*self._hpu(), path, data, **self._kw())

    async def mkdir(self, path: str) -> None:
        if self.is_nc:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.request("MKCOL", _webdav_url(self.nc_user, path),
                                         headers=_auth_header(self.nc_user, self.nc_pass))
            if r.status_code not in (200, 201, 405):
                raise HTTPException(status_code=502, detail=Text("files.mkdirFailed", status=r.status_code))
            return
        await sftp_client.mkdir(*self._hpu(), path, **self._kw())

    async def delete(self, path: str) -> None:
        if self.is_nc:
            async with httpx.AsyncClient(timeout=30.0) as client:
                r = await client.delete(_webdav_url(self.nc_user, path),
                                        headers=_auth_header(self.nc_user, self.nc_pass))
            if r.status_code not in (200, 204, 404):
                raise HTTPException(status_code=502, detail=Text("files.deleteFailed", status=r.status_code))
            return
        await sftp_client.delete(*self._hpu(), path, **self._kw())

    async def dav(self, method: str, src: str, dst: str, overwrite: bool) -> None:
        """Native COPY/MOVE within the same Nextcloud."""
        async with httpx.AsyncClient(timeout=300.0) as client:
            r = await _dav_request(
                client, method, _webdav_url(self.nc_user, src),
                headers={**_auth_header(self.nc_user, self.nc_pass),
                         "Destination": _webdav_url(self.nc_user, dst),
                         "Overwrite": "T" if overwrite else "F"},
            )
        if r.status_code == 412:
            raise HTTPException(status_code=409, detail={"code": "exists", "name": _leaf(dst), "dst": dst})
        if r.status_code not in (201, 204):
            raise HTTPException(status_code=502, detail=f"Nextcloud {method} fehlgeschlagen ({r.status_code})")


async def _resolve_target(dst: _Backend, target: str, src_kind: str, mode: str,
                          same_folder: bool) -> tuple[str | None, bool]:
    """Resolve a conflict at the target → (target path | None=skip, overwrite?)."""
    if mode not in _CONFLICT_MODES:
        raise HTTPException(status_code=400, detail=f"on_conflict muss eines von {_CONFLICT_MODES} sein")
    existing = await dst.kind(target)
    if existing is None:
        return target, False
    if same_folder or mode == "rename":
        folder = _parent(target)
        for cand in _candidate_names(_leaf(target), src_kind == "dir", same_folder):
            p = _join(folder, cand)
            if await dst.kind(p) is None:
                return p, False
        raise HTTPException(status_code=409, detail={"code": "no_free_name", "name": _leaf(target)})
    if mode == "skip":
        return None, False
    if mode == "overwrite":
        if existing != src_kind:
            # Putting a file over a folder (or vice versa) is never intended
            raise HTTPException(status_code=409, detail={
                "code": "type_mismatch", "name": _leaf(target), "dst": target,
                "message": "Am Ziel liegt ein Ordner bzw. eine Datei gleichen Namens."})
        return target, True
    raise HTTPException(status_code=409, detail={
        "code": "exists", "name": _leaf(target), "dst": target, "is_dir": existing == "dir"})


async def _copy_tree(src: _Backend, src_path: str, dst: _Backend, dst_path: str, kind: str,
                     counter: list[int]) -> None:
    """Copy recursively (cross-source or SFTP), file by file."""
    if kind == "dir":
        await dst.mkdir(dst_path)
        for c in await src.children(src_path):
            await _copy_tree(src, c["path"], dst, _join(dst_path, c["name"]),
                             "dir" if c.get("isDir") else "file", counter)
            if counter[0] > _ARCHIVE_MAX_FILES:
                raise HTTPException(status_code=413, detail=f"Zu viele Dateien (>{_ARCHIVE_MAX_FILES})")
    else:
        await dst.write(dst_path, await src.read(src_path))
        counter[0] += 1


def _guard_into_itself(src_path: str, dst_folder: str) -> None:
    s, d = _norm(src_path), _norm(dst_folder)
    if d == s or d.startswith(s.rstrip("/") + "/"):
        raise HTTPException(status_code=400, detail={
            "code": "into_itself", "message": Text("files.intoItself")})


class _MoveBody(BaseModel):
    src_source: str = "nextcloud"
    src_path: str
    dst_source: str = "nextcloud"
    dst_path: str          # full target path (if it ends with '/', the name is kept)
    on_conflict: str = "fail"


@router.post("/move")
async def move_item(request: Request, body: _MoveBody) -> dict:
    """Move a file/folder — natively within one source, otherwise copy + delete.

    409 {code: exists|type_mismatch} on a name conflict (on_conflict=fail).
    """
    user = get_current_user(request)
    if not body.src_path or _norm(body.src_path) == "/":
        raise HTTPException(status_code=400, detail="Cannot move root")
    final = body.dst_path + _leaf(body.src_path) if body.dst_path.endswith("/") else body.dst_path
    final = _norm(final)

    src = await _Backend.open(body.src_source, user)
    dst = src if body.dst_source == body.src_source else await _Backend.open(body.dst_source, user)
    same = _same_backend(src.src, dst.src)
    if same and final == _norm(body.src_path):
        return {"src": body.src_path, "dst": final, "ok": True, "mode": "noop"}
    kind = await src.kind(body.src_path)
    if kind is None:
        raise HTTPException(status_code=404, detail=Text("files.sourceNotFound"))
    if same and kind == "dir":
        _guard_into_itself(body.src_path, _parent(final))
    target, overwrite = await _resolve_target(dst, final, kind, body.on_conflict, same_folder=False)
    if target is None:
        return {"src": body.src_path, "dst": final, "ok": True, "skipped": True}

    if same and src.is_nc:
        await src.dav("MOVE", body.src_path, target, overwrite)
        return {"src": body.src_path, "dst": target, "ok": True, "mode": "native"}
    if same:
        if overwrite:
            await dst.delete(target)
        await sftp_client.rename(*src._hpu(), _norm(body.src_path), target, **src._kw())
        return {"src": body.src_path, "dst": target, "ok": True, "mode": "native"}

    # Cross-source: copy completely first, then (and only then) delete
    if overwrite:
        await dst.delete(target)
    counter = [0]
    await _copy_tree(src, _norm(body.src_path), dst, target, kind, counter)
    await src.delete(body.src_path)
    return {"src": body.src_path, "dst": target, "ok": True, "mode": "cross-source", "files": counter[0]}


class _CopyBody(BaseModel):
    src_source: str
    src_path: str
    dst_source: str
    dst_path: str          # target folder
    on_conflict: str = "fail"


@router.post("/copy")
async def cross_copy(request: Request, body: _CopyBody) -> dict:
    """Copy a file OR folder into a target folder (also across sources).

    A copy into the same folder becomes "Name (Kopie).ext". Otherwise 409
    {code: exists} on a name conflict, unless on_conflict = overwrite | rename | skip.
    """
    user = get_current_user(request)
    src = await _Backend.open(body.src_source, user)
    dst = src if body.dst_source == body.src_source else await _Backend.open(body.dst_source, user)
    kind = await src.kind(body.src_path)
    if kind is None:
        raise HTTPException(status_code=404, detail=Text("files.sourceNotFound"))
    same = _same_backend(src.src, dst.src)
    if kind == "dir" and same:
        _guard_into_itself(body.src_path, body.dst_path)
    target = _join(body.dst_path, _leaf(body.src_path))
    same_folder = same and _parent(body.src_path) == _norm(body.dst_path)
    target, overwrite = await _resolve_target(dst, target, kind, body.on_conflict, same_folder)
    if target is None:
        return {"src": body.src_path, "dst": None, "ok": True, "skipped": True}

    if same and src.is_nc:
        await src.dav("COPY", body.src_path, target, overwrite)
        return {"src": body.src_path, "dst": target, "ok": True, "mode": "native"}
    if overwrite:
        await dst.delete(target)
    counter = [0]
    await _copy_tree(src, _norm(body.src_path), dst, target, kind, counter)
    return {"src": body.src_path, "dst": target, "ok": True, "files": counter[0]}


# ── Download / upload without a size limit ──────────────────────────────
#
# /read returns JSON/Base64 (10 MB limit, whole file in memory, twice the size
# on the wire) and cannot handle folders; the form upload is limited to 10 MB
# as well. These endpoints stream in both directions; folders/multi-selection
# are delivered as ZIP. Nextcloud (>= 31) zips folders itself
# (`Accept: application/zip`, selection via `?files=[…]` on the parent folder),
# so none of it sits in API memory. Only when Nextcloud returns no ZIP or the
# source is an SFTP device does the API zip itself (with the 500 MB archive limit).

from fastapi import Query
from fastapi.responses import StreamingResponse, Response
from urllib.parse import quote as _urlq
from services.download_policy import safe_media


def _disposition(name: str) -> str:
    """RFC 6266/5987: ASCII fallback + UTF-8 name (umlauts, spaces, #)."""
    fallback = name.encode("ascii", "replace").decode().replace('"', "'").replace("?", "_")
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{_urlq(name, safe='')}"


def _head_response(response: Response) -> Response:
    """Keep GET metadata, including an absent length, without a response body."""
    result = Response(status_code=response.status_code, headers=dict(response.headers))
    if "content-length" not in response.headers:
        del result.headers["content-length"]
    return result


async def _stream_nc(url: str, headers: dict, name: str, want_zip: bool,
                     inline: bool = False, head: bool = False) -> Response | None:
    """Proxy a GET to Nextcloud. None = no ZIP received (use the fallback).

    Range requests (video seeking) pass through 1:1 — 206 + Content-Range back."""
    client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=None))
    resp = await client.send(client.build_request("GET", url, headers=headers), stream=True)
    ctype = resp.headers.get("content-type", "")
    if resp.status_code not in (200, 206) or (want_zip and "zip" not in ctype):
        status = resp.status_code
        await resp.aclose()
        await client.aclose()
        if status == 404:
            raise HTTPException(status_code=404, detail=Text("files.notFound"))
        if want_zip and status == 200:
            return None
        raise HTTPException(status_code=502, detail=Text("files.ncDownloadFailed", status=status))

    async def body():
        try:
            async for chunk in resp.aiter_bytes():
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    disp = _disposition(name)
    if want_zip:
        media_type, security = "application/zip", {"X-Content-Type-Options": "nosniff"}
    else:
        media_type, inline, security = safe_media(ctype, inline)
    out_headers = {"Content-Disposition": disp.replace("attachment", "inline", 1) if inline else disp,
                   "Cache-Control": "private, max-age=0", **security}
    if resp.headers.get("content-length") and not resp.headers.get("content-encoding"):
        out_headers["Content-Length"] = resp.headers["content-length"]
    for h in ("content-range", "accept-ranges", "etag", "last-modified"):
        if resp.headers.get(h):
            out_headers[h.title()] = resp.headers[h]
    response = StreamingResponse(body(), status_code=resp.status_code, media_type=media_type, headers=out_headers)
    if head:
        # Read GET headers only: Nextcloud's ZIP fallback and download policy
        # stay identical, but no upstream body is consumed or left open.
        await resp.aclose()
        await client.aclose()
        return _head_response(response)
    return response


async def _zip_in_api(backend: "_Backend", paths: list[str], name: str) -> Response:
    """Fallback: build the ZIP in the API (SFTP, or Nextcloud without ZIP support)."""
    import io
    buf = io.BytesIO()
    total = 0
    count = 0

    async def add(zf, path: str, arc: str) -> None:
        nonlocal total, count
        kind = await backend.kind(path)
        if kind == "dir":
            zf.writestr(arc.rstrip("/") + "/", b"")
            for c in await backend.children(path):
                await add(zf, c["path"], f"{arc.rstrip('/')}/{c['name']}")
        elif kind == "file":
            data = await backend.read(path)
            total += len(data)
            count += 1
            if total > _ARCHIVE_MAX_BYTES or count > _ARCHIVE_MAX_FILES:
                raise HTTPException(status_code=413, detail=Text("files.zipTooLarge"))
            zf.writestr(arc, data)

    with _zipfile.ZipFile(buf, "w", _zipfile.ZIP_DEFLATED) as zf:
        for p in paths:
            await add(zf, p, _leaf(p))
    return Response(buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": _disposition(name), "Cache-Control": "no-store"})


@router.api_route("/download", methods=["GET", "HEAD"])
async def download(request: Request, source: str = "nextcloud",
                   path: list[str] = Query(...), name: str | None = None, inline: bool = False):
    """Stream a file download; folders or multiple paths as ZIP.

    Multiple paths: `?path=/a&path=/b` (same parent folder for Nextcloud's own
    ZIP, otherwise the API zips).
    """
    user = get_current_user(request)
    head = request.method == "HEAD"
    paths = [_norm(p) for p in path if p and _norm(p) != "/"] or ["/"]
    backend = await _Backend.open(source, user)
    single = len(paths) == 1
    kind = await backend.kind(paths[0]) if single else "multi"
    if kind is None:
        raise HTTPException(status_code=404, detail=Text("files.notFound"))

    if single and kind == "file":
        fname = name or _leaf(paths[0])
        if backend.is_nc:
            hdr = _auth_header(backend.nc_user, backend.nc_pass)
            if request.headers.get("range"):
                hdr = {**hdr, "Range": request.headers["range"]}
            return await _stream_nc(_webdav_url(backend.nc_user, paths[0]), hdr, fname,
                                    want_zip=False, inline=inline, head=head)
        src = backend.src
        response = StreamingResponse(
            sftp_client.stream_file(src["host"], src["port"], src["user"], paths[0], key_path=src.get("key_path")),
            media_type="application/octet-stream",
            headers={"Content-Disposition": _disposition(fname), "Cache-Control": "no-store"},
        )

        return _head_response(response) if head else response

    zip_name = name or (f"{_leaf(paths[0])}.zip" if single else f"{_leaf(_parent(paths[0])) or 'Auswahl'}.zip")
    if backend.is_nc:
        hdr = {**_auth_header(backend.nc_user, backend.nc_pass), "Accept": "application/zip"}
        parents = {_parent(p) for p in paths}
        if single:
            url = _webdav_url(backend.nc_user, paths[0])
        elif len(parents) == 1:
            url = (_webdav_url(backend.nc_user, parents.pop())
                   + "?files=" + _urlq(_json.dumps([_leaf(p) for p in paths]), safe=""))
        else:
            url = None
        if url:
            streamed = await _stream_nc(url, hdr, zip_name, want_zip=True, head=head)
            if streamed is not None:
                return streamed
    # The fallback builds the archive for GET too; retain its actual length.
    response = await _zip_in_api(backend, paths, zip_name)
    return _head_response(response) if head else response


_PREVIEW_MAX_BYTES = 200 * 1024 * 1024


@router.get("/as-jpeg")
async def as_jpeg(request: Request, source: str = "nextcloud", path: str = "", size: int = 4096):
    """Serve image formats the browser cannot render (TIFF; HEIC only with
    pillow-heif) as JPEG. Nextcloud does not generate previews for these."""
    user = get_current_user(request)
    backend = await _Backend.open(source, user)
    if await backend.kind(path) != "file":
        raise HTTPException(status_code=404, detail=Text("files.notFound"))
    data = await backend.read(path)
    if len(data) > _PREVIEW_MAX_BYTES:
        raise HTTPException(status_code=413, detail=Text("files.imageTooLarge"))
    import io
    from PIL import Image, ImageOps
    try:
        try:
            import pillow_heif  # optional — only if installed
            pillow_heif.register_heif_opener()
        except ImportError:
            pass
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img)
        img.thumbnail((max(64, min(size, 8192)),) * 2)
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        out = io.BytesIO()
        img.save(out, "JPEG", quality=90)
    except Exception as e:  # noqa: BLE001 — report unreadable formats honestly
        raise HTTPException(status_code=415, detail=Text("files.imageConvert", error=type(e).__name__))
    return Response(out.getvalue(), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=300"})


@router.put("/upload-stream")
async def upload_stream(request: Request, name: str, source: str = "nextcloud",
                        path: str = "/", on_conflict: str = "fail") -> dict:
    """Raw upload without a form and without the 10 MB limit — the body is
    streamed through, never fully loaded. Conflicts as in /copy (fail → 409)."""
    user = get_current_user(request)
    if not name or "/" in name or name in (".", ".."):
        raise HTTPException(status_code=400, detail=Text("files.badName"))
    backend = await _Backend.open(source, user)
    target, overwrite = await _resolve_target(backend, _join(path, name), "file", on_conflict, same_folder=False)
    if target is None:
        return {"ok": True, "skipped": True}
    size = 0

    async def counted():
        nonlocal size
        async for chunk in request.stream():
            size += len(chunk)
            yield chunk

    if backend.is_nc:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=None, write=None)) as client:
            r = await client.put(_webdav_url(backend.nc_user, target),
                                 headers={**_auth_header(backend.nc_user, backend.nc_pass),
                                          "Content-Type": request.headers.get("content-type", "application/octet-stream")},
                                 content=counted())
        if r.status_code not in (200, 201, 204):
            raise HTTPException(status_code=502, detail=Text("files.ncUploadFailed", status=r.status_code))
    else:
        src = backend.src
        await sftp_client.write_stream(src["host"], src["port"], src["user"], target, counted(),
                                       key_path=src.get("key_path"))
    return {"ok": True, "path": target, "size": size, "overwritten": overwrite}


# ── Shortcut creation + GF detection ───────────────────────


class _ShortcutBody(BaseModel):
    target: str                      # absolute Nextcloud path of the link target
    name: str | None = None          # display name; defaults to target's basename
    target_source: str = "nextcloud"
    target_type: str = "shortcut"    # "shortcut" or future variants
    icon: str | None = None
    desktop_path: str = "/Desktop"   # destination folder on the user's Nextcloud


@router.post("/shortcut")
async def create_shortcut(request: Request, body: _ShortcutBody) -> dict:
    """Create a .lnk.json shortcut file in the user's Desktop folder.

    Idempotent on filename collisions: if `<name>.lnk.json` already exists,
    appends ` (1)`, ` (2)`, ... before the suffix until a free name is found.
    """
    import os as _os

    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])

    # Ensure /Desktop exists for this user
    if body.desktop_path == "/Desktop":
        await _ensure_desktop_folder(nc_user, nc_pass)

    base_name = (body.name or body.target.rstrip("/").rsplit("/", 1)[-1]).strip()
    if not base_name:
        raise HTTPException(status_code=400, detail="Shortcut name is empty")
    base_name = base_name.replace("/", "_")

    payload = {
        "v": 1,
        "type": body.target_type,
        "target": body.target,
        "source": body.target_source,
    }
    if body.icon:
        payload["icon"] = body.icon
    content = _json.dumps(payload, ensure_ascii=False).encode("utf-8")

    # Find a free filename
    desktop_root = body.desktop_path.rstrip("/") or "/Desktop"
    candidate = f"{desktop_root}/{base_name}{SHORTCUT_SUFFIX}"
    headers = {**_auth_header(nc_user, nc_pass), "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=10.0) as client:
        for n in range(0, 50):
            test_path = (
                candidate if n == 0
                else f"{desktop_root}/{base_name} ({n}){SHORTCUT_SUFFIX}"
            )
            head = await client.request(
                "PROPFIND",
                _webdav_url(nc_user, test_path),
                headers={**_auth_header(nc_user, nc_pass), "Depth": "0"},
            )
            if head.status_code == 404:
                resp = await client.put(
                    _webdav_url(nc_user, test_path),
                    headers=headers,
                    content=content,
                )
                if resp.status_code not in (200, 201, 204):
                    raise HTTPException(
                        status_code=502,
                        detail=f"Nextcloud shortcut write failed: {resp.status_code}",
                    )
                return {
                    "path": test_path,
                    "name": _os.path.basename(test_path)[: -len(SHORTCUT_SUFFIX)],
                    "ok": True,
                }
        raise HTTPException(status_code=409, detail="Too many collisions for shortcut name")


# ── Sharing (Nextcloud OCS Share API) ───────────────────────────────────
#
# The recipient side exists separately (a recipient view under /share/…); these
# endpoints let the file manager create and manage public links itself instead
# of going through the Nextcloud UI.


class _ShareBody(BaseModel):
    source: str = "nextcloud"
    path: str
    password: str = ""
    # ISO date (YYYY-MM-DD); empty = no expiry
    expires: str = ""
    # 1 = read only, 15 = read+write+create+delete (NC permission bits)
    permissions: int = 1


def _ocs_headers(nc_user: str, nc_pass: str) -> dict:
    return {
        **_auth_header(nc_user, nc_pass),
        "OCS-APIRequest": "true",
        "Accept": "application/json",
    }


@router.get("/shares")
async def list_shares(request: Request, path: str = "") -> dict:
    """Existing links for a file/folder."""
    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])
    params = {"format": "json", "reshares": "false"}
    if path:
        params["path"] = path
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(
            f"{NEXTCLOUD_INTERNAL_URL}/ocs/v2.php/apps/files_sharing/api/v1/shares",
            headers=_ocs_headers(nc_user, nc_pass), params=params,
        )
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Nextcloud-Freigaben: {r.status_code}")
    data = r.json().get("ocs", {}).get("data", []) or []
    return {
        "shares": [
            {
                "id": str(s.get("id")),
                "url": s.get("url", ""),
                "path": s.get("path", ""),
                "hasPassword": bool(s.get("share_with")),
                "expiration": (s.get("expiration") or "")[:10],
                "permissions": s.get("permissions", 1),
            }
            for s in data
            if str(s.get("share_type")) == "3"  # 3 = public link
        ]
    }


@router.post("/share")
async def create_share(request: Request, body: _ShareBody) -> dict:
    """Create a public link — optionally with password and expiry date."""
    user = get_current_user(request)
    if _parse_source(body.source).get("type") != "nextcloud":
        raise HTTPException(status_code=400, detail=Text("files.shareNcOnly"))
    nc_user, nc_pass = await _nc_credentials(user["username"])

    form = {
        "path": body.path,
        "shareType": "3",
        "permissions": str(body.permissions),
    }
    if body.password:
        form["password"] = body.password
    if body.expires:
        form["expireDate"] = body.expires

    async with httpx.AsyncClient(timeout=25.0) as client:
        r = await client.post(
            f"{NEXTCLOUD_INTERNAL_URL}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json",
            headers=_ocs_headers(nc_user, nc_pass), data=form,
        )
    if r.status_code >= 400:
        # Nextcloud explains the reason in the OCS body — pass it on, otherwise
        # the user faces a bare 502 (e.g. "password too short").
        detail = ""
        try:
            detail = r.json().get("ocs", {}).get("meta", {}).get("message", "")
        except Exception:
            pass
        raise HTTPException(status_code=502, detail=detail or f"Nextcloud: {r.status_code}")

    s = r.json().get("ocs", {}).get("data", {}) or {}
    return {
        "id": str(s.get("id")),
        "url": s.get("url", ""),
        "hasPassword": bool(body.password),
        "expiration": (s.get("expiration") or "")[:10],
    }


@router.delete("/share/{share_id}")
async def delete_share(share_id: str, request: Request) -> dict:
    """Revoke a link."""
    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.delete(
            f"{NEXTCLOUD_INTERNAL_URL}/ocs/v2.php/apps/files_sharing/api/v1/shares/{share_id}?format=json",
            headers=_ocs_headers(nc_user, nc_pass),
        )
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Nextcloud: {r.status_code}")
    return {"status": "ok"}


@router.get("/group-folders")
async def list_group_folders(request: Request) -> list[str]:
    """Return the list of top-level Group Folder names visible to the current user.

    Compares the user's DAV root listing to a configured GF-name allowlist. The
    frontend uses this to decide whether to default a drag-from-FilesApp-to-Desktop
    to a shortcut (because Move into /Desktop usually fails on GFs).

    Configurable via env CLARAOS_GROUP_FOLDER_NAMES="Engineering,Marketing,...".
    Empty/unset → empty list (frontend will treat all sources as user-owned).
    """
    import os as _os

    raw = _os.environ.get("CLARAOS_GROUP_FOLDER_NAMES", "")
    if not raw.strip():
        return []
    configured = {n.strip() for n in raw.split(",") if n.strip()}

    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])

    # Listing only top-level dirs to filter against the configured allowlist
    propfind_body = """<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>"""
    headers = {**_auth_header(nc_user, nc_pass), "Depth": "1", "Content-Type": "application/xml"}

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.request(
                "PROPFIND", _webdav_url(nc_user, "/"), headers=headers, content=propfind_body,
            )
        if resp.status_code not in (200, 207):
            return []
        children = _parse_propfind(resp.content, nc_user, "/")
    except Exception:  # noqa: BLE001
        return []

    visible = {c["name"] for c in children if c.get("isDir")}
    return sorted(configured & visible)


# ---------------------------------------------------------------------------
# Archive + encrypt — a folder (or single file) is collected server-side via
# WebDAV and stored as a ZIP or AES-256 ZIP (pyzipper, 7-Zip/WinRAR compatible)
# NEXT TO the original.
# ---------------------------------------------------------------------------
import io as _io
import zipfile as _zipfile

_ARCHIVE_MAX_FILES = 2000
_ARCHIVE_MAX_BYTES = 500 * 1024 * 1024  # 500 MB raw data


async def _walk_nc_files(client: "httpx.AsyncClient", nc_user: str, nc_pass: str, path: str) -> list[dict]:
    """Recursive file list (Depth-1 PROPFIND per level — Depth:infinity is often disabled in NC)."""
    headers = {**_auth_header(nc_user, nc_pass), "Depth": "1", "Content-Type": "application/xml"}
    body = """<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>"""
    out: list[dict] = []
    queue = [path]
    while queue:
        cur = queue.pop(0)
        resp = await client.request("PROPFIND", _webdav_url(nc_user, cur), headers=headers, content=body)
        if resp.status_code not in (200, 207):
            raise HTTPException(status_code=502, detail=f"Nextcloud PROPFIND {resp.status_code} bei {cur}")
        for c in _parse_propfind(resp.content, nc_user, cur):
            if c.get("isDir"):
                queue.append(c["path"])
            else:
                out.append(c)
        if len(out) > _ARCHIVE_MAX_FILES:
            raise HTTPException(status_code=413, detail=f"Zu viele Dateien (>{_ARCHIVE_MAX_FILES})")
    return out


async def _collect_folder(nc_user: str, nc_pass: str, path: str) -> list[tuple[str, bytes]]:
    """Download all files of a folder (or the single file) → [(arcname, bytes)]."""
    base = path.rstrip("/")
    root_name = base.rsplit("/", 1)[-1] or "archiv"
    async with httpx.AsyncClient(timeout=60.0) as client:
        # Is it a folder at all? Single file → pack it directly.
        head = await client.request(
            "PROPFIND", _webdav_url(nc_user, base),
            headers={**_auth_header(nc_user, nc_pass), "Depth": "0", "Content-Type": "application/xml"},
            content='<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
        )
        if head.status_code == 404:
            raise HTTPException(status_code=404, detail=Text("files.pathNotFound"))
        is_dir = b"<d:collection" in head.content or b"collection" in head.content
        files = (await _walk_nc_files(client, nc_user, nc_pass, base)) if is_dir else [{"path": base, "size": 0}]

        total = 0
        collected: list[tuple[str, bytes]] = []
        for f in files:
            resp = await client.get(_webdav_url(nc_user, f["path"]), headers=_auth_header(nc_user, nc_pass))
            if resp.status_code != 200:
                raise HTTPException(status_code=502, detail=f"Download fehlgeschlagen: {f['path']}")
            data = resp.content
            total += len(data)
            if total > _ARCHIVE_MAX_BYTES:
                raise HTTPException(status_code=413, detail=Text("files.folderTooLarge"))
            # Normalize paths: _parse_propfind returns '/Folder/x' while base may
            # arrive without a leading slash — a naive [len(base):] would strip
            # one character too few (yielding arcnames like 'b/hello.txt').
            p_norm = "/" + f["path"].lstrip("/")
            b_norm = "/" + base.lstrip("/")
            rel = (p_norm[len(b_norm):].lstrip("/") if p_norm.startswith(b_norm + "/") else p_norm.lstrip("/")) if is_dir else root_name
            arcname = f"{root_name}/{rel}" if is_dir else rel
            collected.append((arcname, data))
        return collected


async def _put_result(nc_user: str, nc_pass: str, target: str, data: bytes) -> str:
    """PUT with a collision suffix (-1, -2 …) instead of overwriting."""
    async with httpx.AsyncClient(timeout=120.0) as client:
        candidate = target
        stem, dot, ext = target.rpartition(".")
        for i in range(1, 50):
            head = await client.head(_webdav_url(nc_user, candidate), headers=_auth_header(nc_user, nc_pass))
            if head.status_code == 404:
                break
            candidate = f"{stem}-{i}{dot}{ext}" if dot else f"{target}-{i}"
        resp = await client.put(
            _webdav_url(nc_user, candidate),
            headers={**_auth_header(nc_user, nc_pass), "Content-Type": "application/zip"},
            content=data,
        )
        if resp.status_code not in (200, 201, 204):
            raise HTTPException(status_code=502, detail=f"Upload fehlgeschlagen: {resp.status_code}")
        return candidate


class _ArchiveBody(BaseModel):
    source: str = "nextcloud"
    path: str


@router.post("/archive")
async def archive_folder(request: Request, body: _ArchiveBody) -> dict:
    """Store a folder/file as ZIP next to the original (Nextcloud only)."""
    user = get_current_user(request)
    if _parse_source(body.source)["type"] != "nextcloud":
        raise HTTPException(status_code=400, detail=Text("files.archiveNcOnly"))
    nc_user, nc_pass = await _nc_credentials(user["username"])
    entries = await _collect_folder(nc_user, nc_pass, body.path)
    buf = _io.BytesIO()
    with _zipfile.ZipFile(buf, "w", _zipfile.ZIP_DEFLATED) as zf:
        for arcname, data in entries:
            zf.writestr(arcname, data)
    target = body.path.rstrip("/") + ".zip"
    created = await _put_result(nc_user, nc_pass, target, buf.getvalue())
    return {"ok": True, "path": created, "files": len(entries), "size": buf.tell()}


class _EncryptBody(BaseModel):
    source: str = "nextcloud"
    path: str
    password: str


@router.post("/encrypt")
async def encrypt_folder(request: Request, body: _EncryptBody) -> dict:
    """Store a folder/file as an AES-256 encrypted ZIP next to the original.

    pyzipper writes WinZip AES — compatible with 7-Zip/WinRAR/Keka. The password
    is NOT stored; without it the archive cannot be read.
    """
    import pyzipper  # lazy — keeps cold start lean
    user = get_current_user(request)
    if _parse_source(body.source)["type"] != "nextcloud":
        raise HTTPException(status_code=400, detail=Text("files.encryptNcOnly"))
    if len(body.password) < 4:
        raise HTTPException(status_code=400, detail=Text("files.passwordShort"))
    nc_user, nc_pass = await _nc_credentials(user["username"])
    entries = await _collect_folder(nc_user, nc_pass, body.path)
    buf = _io.BytesIO()
    with pyzipper.AESZipFile(buf, "w", compression=pyzipper.ZIP_DEFLATED, encryption=pyzipper.WZ_AES) as zf:
        zf.setpassword(body.password.encode("utf-8"))
        for arcname, data in entries:
            zf.writestr(arcname, data)
    target = body.path.rstrip("/") + ".verschluesselt.zip"
    created = await _put_result(nc_user, nc_pass, target, buf.getvalue())
    return {"ok": True, "path": created, "files": len(entries), "size": buf.tell()}


async def _dav_request(client: httpx.AsyncClient, method: str, url: str, *, attempts: int = 3, **kw) -> httpx.Response:
    """WebDAV call with retry — NC drops keep-alive connections during
    request bursts; httpx then raises RemoteProtocolError although a fresh
    attempt succeeds immediately."""
    import asyncio as _asyncio
    for attempt in range(attempts):
        try:
            return await client.request(method, url, **kw)
        except httpx.RemoteProtocolError:
            if attempt == attempts - 1:
                raise
            await _asyncio.sleep(0.2 * (attempt + 1))
    raise AssertionError("unreachable")


class _ExtractBody(BaseModel):
    source: str = "nextcloud"
    path: str
    password: str | None = None


@router.post("/extract")
async def extract_archive(request: Request, body: _ExtractBody) -> dict:
    """Extract a ZIP (also AES/ZipCrypto encrypted) into a folder next to the archive.

    Counterpart to /archive and /encrypt: pyzipper reads regular AND WinZip
    AES archives. Encrypted + no password → 400 with "Passwort erforderlich"
    (the UI then asks for it).
    """
    import pyzipper  # lazy — keeps cold start lean
    user = get_current_user(request)
    if _parse_source(body.source)["type"] != "nextcloud":
        raise HTTPException(status_code=400, detail=Text("files.extractNcOnly"))
    nc_user, nc_pass = await _nc_credentials(user["username"])

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await _dav_request(client, "GET", _webdav_url(nc_user, body.path), headers=_auth_header(nc_user, nc_pass))
        if resp.status_code == 404:
            raise HTTPException(status_code=404, detail=Text("files.archiveNotFound"))
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Download fehlgeschlagen: {resp.status_code}")
        raw = resp.content
    if len(raw) > _ARCHIVE_MAX_BYTES:
        raise HTTPException(status_code=413, detail=Text("files.archiveTooLarge"))

    try:
        zf = pyzipper.AESZipFile(_io.BytesIO(raw))
        members = [i for i in zf.infolist() if not i.is_dir()]
    except Exception:
        raise HTTPException(status_code=400, detail=Text("files.notZip"))
    if not members:
        raise HTTPException(status_code=400, detail=Text("files.archiveEmpty"))
    if sum(i.file_size for i in members) > _ARCHIVE_MAX_BYTES:
        raise HTTPException(status_code=413, detail=Text("files.extractedTooLarge"))

    if any(i.flag_bits & 0x1 for i in members):
        if not body.password:
            raise HTTPException(status_code=400, detail=Text("files.archiveEncrypted"))
        zf.setpassword(body.password.encode("utf-8"))

    # Zip-slip protection: only relative paths without '..'; normalize backslashes
    safe: list[tuple[str, object]] = []
    for info in members:
        parts = [p for p in info.filename.replace("\\", "/").split("/") if p not in ("", ".")]
        if not parts or ".." in parts:
            raise HTTPException(status_code=400, detail=f"Unsicherer Pfad im Archiv: {info.filename}")
        safe.append(("/".join(parts), info))

    # Avoid double nesting: if EVERYTHING is inside a single top-level folder
    # (our /archive ZIPs), strip that prefix — otherwise we would get
    # target/foldername/… instead of target/…
    tops = {rel.split("/", 1)[0] for rel, _ in safe}
    if len(tops) == 1 and all("/" in rel for rel, _ in safe):
        safe = [(rel.split("/", 1)[1], info) for rel, info in safe]

    # Check the password BEFORE creating the target folder (smallest member suffices)
    probe = min(members, key=lambda i: i.file_size)
    try:
        zf.read(probe)
    except RuntimeError:
        raise HTTPException(status_code=400, detail="Falsches Passwort")
    except Exception:
        raise HTTPException(status_code=400, detail=Text("files.archiveBroken"))

    # Target folder next to the archive: foo.zip → foo/, foo.verschluesselt.zip → foo/
    stem = body.path.rstrip("/")
    if stem.lower().endswith(".zip"):
        stem = stem[:-4]
    if stem.lower().endswith(".verschluesselt"):
        stem = stem[: -len(".verschluesselt")]
    if not stem.strip("/"):  # archive was named just ".zip" or similar
        stem = body.path.rstrip("/") + ".entpackt"

    async with httpx.AsyncClient(timeout=120.0) as client:
        target = stem
        for i in range(1, 50):
            head = await _dav_request(client, "HEAD", _webdav_url(nc_user, target), headers=_auth_header(nc_user, nc_pass))
            if head.status_code == 404:
                break
            target = f"{stem}-{i}"

        made: set[str] = set()

        async def _ensure_dir(rel_dir: str) -> None:
            segs = [s for s in rel_dir.split("/") if s]
            cur = target
            for seg in [""] + segs:
                cur = f"{cur}/{seg}" if seg else cur
                if cur in made:
                    continue
                resp = await _dav_request(client, "MKCOL", _webdav_url(nc_user, cur), headers=_auth_header(nc_user, nc_pass))
                if resp.status_code not in (201, 405):  # 405 = already exists
                    raise HTTPException(status_code=502, detail=f"Ordner-Anlage fehlgeschlagen: {resp.status_code}")
                made.add(cur)

        total = 0
        for rel, info in safe:
            try:
                data = zf.read(info)
            except RuntimeError:
                raise HTTPException(status_code=400, detail="Falsches Passwort")
            total += len(data)
            if total > _ARCHIVE_MAX_BYTES:
                raise HTTPException(status_code=413, detail=Text("files.extractedTooLarge"))
            await _ensure_dir(rel.rpartition("/")[0])
            resp = await _dav_request(
                client, "PUT", _webdav_url(nc_user, f"{target}/{rel}"),
                headers={**_auth_header(nc_user, nc_pass), "Content-Type": "application/octet-stream"},
                content=data,
            )
            if resp.status_code not in (200, 201, 204):
                raise HTTPException(status_code=502, detail=f"Upload fehlgeschlagen: {rel} ({resp.status_code})")

    return {"ok": True, "folder": target, "files": len(safe), "size": total}


async def _nc_fileid(nc_user: str, nc_pass: str, path: str) -> str:
    body = ('<?xml version="1.0"?>'
            '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">'
            '<d:prop><oc:fileid/></d:prop></d:propfind>')
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.request(
            "PROPFIND", _webdav_url(nc_user, path),
            headers={**_auth_header(nc_user, nc_pass), "Depth": "0", "Content-Type": "application/xml"},
            content=body,
        )
    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail=Text("files.fileNotFound"))
    if resp.status_code not in (200, 207):
        raise HTTPException(status_code=502, detail=f"Nextcloud error: {resp.status_code}")
    import re as _re
    m = _re.search(rb"<oc:fileid>(\d+)</oc:fileid>", resp.content)
    if not m:
        raise HTTPException(status_code=502, detail="fileid nicht in PROPFIND-Antwort")
    return m.group(1).decode()


@router.get("/fileid")
async def get_file_id(request: Request, source: str = "nextcloud", path: str = "") -> dict:
    """Nextcloud fileId for a path (for /f/<id> deep links, office viewer)."""
    user = get_current_user(request)
    if _parse_source(source)["type"] != "nextcloud":
        raise HTTPException(status_code=400, detail="fileid nur für Nextcloud-Quellen")
    nc_user, nc_pass = await _nc_credentials(user["username"])
    file_id = await _nc_fileid(nc_user, nc_pass, path)
    return {"fileId": file_id, "path": path, "source": source}


# ── File versions (Nextcloud versions DAV) ──────────────────────────────
# Modeled on the Nextcloud "Versions" sidebar: list, restore, download.

def _versions_url(nc_user: str, sub: str) -> str:
    return f"{NEXTCLOUD_INTERNAL_URL.rstrip('/')}/remote.php/dav/versions/{nc_user}/{sub}"


@router.get("/versions")
async def list_versions(request: Request, source: str = "nextcloud", path: str = "") -> dict:
    """Previous versions of a file (PROPFIND on versions/<fileid>)."""
    user = get_current_user(request)
    if _parse_source(source)["type"] != "nextcloud":
        raise HTTPException(status_code=400, detail=Text("files.versionsNcOnly"))
    nc_user, nc_pass = await _nc_credentials(user["username"])
    file_id = await _nc_fileid(nc_user, nc_pass, path)
    body = ('<?xml version="1.0"?>'
            '<d:propfind xmlns:d="DAV:">'
            '<d:prop><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>')
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await _dav_request(
            client, "PROPFIND", _versions_url(nc_user, f"versions/{file_id}"),
            headers={**_auth_header(nc_user, nc_pass), "Depth": "1", "Content-Type": "application/xml"},
            content=body,
        )
    if resp.status_code == 404:
        return {"path": path, "fileId": file_id, "versions": []}
    if resp.status_code not in (200, 207):
        raise HTTPException(status_code=502, detail=f"Nextcloud Versions: {resp.status_code}")
    import xml.etree.ElementTree as _ET
    ns = "{DAV:}"
    versions = []
    root = _ET.fromstring(resp.content)
    for response in root.findall(f"{ns}response"):
        href = (response.findtext(f"{ns}href") or "").rstrip("/")
        leaf = href.split("/")[-1]
        # skip the collection itself (ends with the fileid)
        if not leaf or leaf == str(file_id):
            continue
        modified = response.findtext(f".//{ns}getlastmodified") or ""
        size = response.findtext(f".//{ns}getcontentlength") or ""
        versions.append({
            "id": leaf,
            "modified": modified,
            "size": int(size) if size.isdigit() else None,
        })
    # newest first (IDs are Unix timestamps)
    versions.sort(key=lambda v: v["id"], reverse=True)
    return {"path": path, "fileId": file_id, "versions": versions}


class _RestoreVersionBody(BaseModel):
    path: str
    version: str


@router.post("/versions/restore")
async def restore_version(request: Request, body: _RestoreVersionBody) -> dict:
    """Restore a version (MOVE to versions/<user>/restore/target)."""
    user = get_current_user(request)
    if not body.version or "/" in body.version:
        raise HTTPException(status_code=422, detail="Ungültige Versions-ID.")
    nc_user, nc_pass = await _nc_credentials(user["username"])
    file_id = await _nc_fileid(nc_user, nc_pass, body.path)
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await _dav_request(
            client, "MOVE", _versions_url(nc_user, f"versions/{file_id}/{body.version}"),
            headers={
                **_auth_header(nc_user, nc_pass),
                "Destination": _versions_url(nc_user, "restore/target"),
            },
        )
    if resp.status_code not in (201, 204):
        raise HTTPException(status_code=502, detail=Text("files.restoreFailed", status=resp.status_code))
    return {"status": "ok", "path": body.path, "restored": body.version}


@router.get("/versions/download")
async def download_version(request: Request, path: str = "", version: str = ""):
    """Download the content of a previous version (without restoring it)."""
    from fastapi.responses import Response as FastAPIResponse
    user = get_current_user(request)
    if not version or "/" in version:
        raise HTTPException(status_code=422, detail="Ungültige Versions-ID.")
    nc_user, nc_pass = await _nc_credentials(user["username"])
    file_id = await _nc_fileid(nc_user, nc_pass, path)
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.get(
            _versions_url(nc_user, f"versions/{file_id}/{version}"),
            headers=_auth_header(nc_user, nc_pass),
        )
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=Text("files.versionUnloadable", status=resp.status_code))
    name = path.rstrip("/").split("/")[-1] or "version"
    return FastAPIResponse(
        content=resp.content,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{name}.{version}"'},
    )


# ── Trash bin (Nextcloud trashbin DAV) ────────────────────────────────────
#
# NC automatically moves items to the trash bin on DAV DELETE — /delete stays
# unchanged. These endpoints list/restore/empty it.
# Note: users without their own NC credentials go through the service account
#   and share its trash bin (same semantics as their files).


def _trash_url(nc_user: str, sub: str = "trash", leaf: str = "") -> str:
    from urllib.parse import quote
    base = NEXTCLOUD_INTERNAL_URL.rstrip("/")
    url = f"{base}/remote.php/dav/trashbin/{nc_user}/{sub}"
    if leaf:
        url += "/" + quote(leaf, safe="")
    return url


@router.get("/trash")
async def list_trash(request: Request) -> list[dict]:
    """Trash bin contents (name, original path, deletion time, size)."""
    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])
    body = (
        '<?xml version="1.0"?>'
        '<d:propfind xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns">'
        "<d:prop>"
        "<nc:trashbin-filename/><nc:trashbin-original-location/>"
        "<nc:trashbin-deletion-time/><d:resourcetype/><d:getcontentlength/>"
        "</d:prop></d:propfind>"
    )
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await _dav_request(
            client, "PROPFIND", _trash_url(nc_user),
            headers={**_auth_header(nc_user, nc_pass), "Depth": "1", "Content-Type": "application/xml"},
            content=body,
        )
    if resp.status_code not in (200, 207):
        raise HTTPException(status_code=502, detail=f"Trashbin: {resp.status_code}")

    import xml.etree.ElementTree as ET
    ns = {"d": "DAV:", "nc": "http://nextcloud.org/ns"}
    items: list[dict] = []
    root = ET.fromstring(resp.content)
    for response in root.findall("d:response", ns):
        href = response.findtext("d:href", default="", namespaces=ns)
        # skip the self entry (the trash folder)
        if href.rstrip("/").endswith("/trash"):
            continue
        prop = response.find("d:propstat/d:prop", ns)
        if prop is None:
            continue
        from urllib.parse import unquote
        trash_leaf = unquote(href.rstrip("/").rsplit("/", 1)[-1])
        is_dir = prop.find("d:resourcetype/d:collection", ns) is not None
        size_txt = prop.findtext("d:getcontentlength", default="", namespaces=ns)
        del_time = prop.findtext("nc:trashbin-deletion-time", default="", namespaces=ns)
        items.append({
            "name": prop.findtext("nc:trashbin-filename", default=trash_leaf, namespaces=ns),
            "trashPath": trash_leaf,
            "originalPath": prop.findtext("nc:trashbin-original-location", default="", namespaces=ns),
            "deletedAt": int(del_time) if del_time.isdigit() else None,
            "isDir": is_dir,
            **({"size": int(size_txt)} if size_txt.isdigit() else {}),
        })
    items.sort(key=lambda x: x.get("deletedAt") or 0, reverse=True)
    return items


class _TrashRestoreBody(BaseModel):
    trash_path: str


@router.post("/trash/restore")
async def restore_trash_item(request: Request, body: _TrashRestoreBody) -> dict:
    """Restore an item from the trash bin to its original location."""
    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])
    leaf = body.trash_path.strip("/")
    if not leaf or "/" in leaf or ".." in leaf:
        raise HTTPException(status_code=400, detail="Ungültiger trash_path")
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await _dav_request(
            client, "MOVE", _trash_url(nc_user, "trash", leaf),
            headers={
                **_auth_header(nc_user, nc_pass),
                "Destination": _trash_url(nc_user, "restore", leaf),
            },
        )
    if resp.status_code not in (200, 201, 204):
        raise HTTPException(status_code=502, detail=Text("files.restoreFailed", status=resp.status_code))
    return {"ok": True}


@router.delete("/trash/item")
async def purge_trash_item(request: Request, path: str) -> dict:
    """Permanently delete an item from the trash bin."""
    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])
    leaf = path.strip("/")
    if not leaf or "/" in leaf or ".." in leaf:
        raise HTTPException(status_code=400, detail="Ungültiger Pfad")
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await _dav_request(
            client, "DELETE", _trash_url(nc_user, "trash", leaf),
            headers=_auth_header(nc_user, nc_pass),
        )
    if resp.status_code not in (200, 204):
        raise HTTPException(status_code=502, detail=Text("files.deleteFailed2", status=resp.status_code))
    return {"ok": True}


@router.post("/trash/empty")
async def empty_trash(request: Request) -> dict:
    """Empty the trash bin completely."""
    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await _dav_request(
            client, "DELETE", _trash_url(nc_user),
            headers=_auth_header(nc_user, nc_pass),
        )
    if resp.status_code not in (200, 204):
        raise HTTPException(status_code=502, detail=Text("files.emptyFailed", status=resp.status_code))
    return {"ok": True}


# ── Search ────────────────────────────────────────────────────────────────


@router.get("/search")
async def search_files(request: Request, q: str, source: str = "nextcloud",
                       path: str = "/", limit: int = 200) -> dict:
    """Recursive name search.

    Nextcloud: WebDAV SEARCH (RFC 5323 basicsearch) — ONE request, answered
    from the filecache DB instead of a PROPFIND walk per folder.
    SFTP: bounded BFS (500 folders / 15 s wall time / `limit` hits).
    """
    user = get_current_user(request)
    q = q.strip()
    if not q:
        raise HTTPException(status_code=400, detail=Text("files.searchMissing"))
    limit = max(1, min(limit, 500))
    src = _parse_source(source)

    if src["type"] == "nextcloud":
        return await _nc_search(user["username"], q, path, limit)
    src = await _reachable(src, user)
    return await _sftp_search(src, q, path, limit)


# ── NC favorites (places panel) ─────────────────────────────────────────
# Server-side favorites: oc:favorite via DAV.

@router.get("/favorites")
async def list_favorites(request: Request) -> dict:
    """All favorited files/folders (REPORT oc:filter-files)."""
    user = get_current_user(request)
    nc_user, nc_pass = await _nc_credentials(user["username"])
    body = """<?xml version="1.0"?>
<oc:filter-files xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <oc:filter-rules><oc:favorite>1</oc:favorite></oc:filter-rules>
  <d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop>
</oc:filter-files>"""
    url = f"{NEXTCLOUD_INTERNAL_URL.rstrip('/')}/remote.php/dav/files/{nc_user}"
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await _dav_request(
            client, "REPORT", url,
            headers={**_auth_header(nc_user, nc_pass), "Content-Type": "text/xml"},
            content=body,
        )
    if resp.status_code not in (200, 207):
        raise HTTPException(status_code=502, detail=f"Nextcloud REPORT: {resp.status_code}")
    results = _parse_propfind(resp.content, nc_user, "")
    for r in results:
        r["source"] = "nextcloud"
    return {"favorites": results}


class _FavoriteBody(BaseModel):
    path: str
    value: bool = True


@router.post("/favorite")
async def set_favorite(request: Request, body: _FavoriteBody) -> dict:
    """Set/remove the star (PROPPATCH oc:favorite)."""
    user = get_current_user(request)
    if not body.path or body.path == "/":
        raise HTTPException(status_code=422, detail="Pfad fehlt.")
    nc_user, nc_pass = await _nc_credentials(user["username"])
    prop = f"""<?xml version="1.0"?>
<d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:set><d:prop><oc:favorite>{1 if body.value else 0}</oc:favorite></d:prop></d:set>
</d:propertyupdate>"""
    url = _webdav_url(nc_user, body.path)
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await _dav_request(
            client, "PROPPATCH", url,
            headers={**_auth_header(nc_user, nc_pass), "Content-Type": "text/xml"},
            content=prop,
        )
    if resp.status_code not in (200, 207):
        raise HTTPException(status_code=502, detail=f"Nextcloud PROPPATCH: {resp.status_code}")
    return {"status": "ok", "path": body.path, "favorite": body.value}


def _xml_escape(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;").replace("'", "&apos;"))


async def _nc_search(username: str, q: str, path: str, limit: int) -> dict:
    nc_user, nc_pass = await _nc_credentials(username)
    # Escape LIKE wildcards in the search term, then wrap in a %…% pattern
    pattern = "%" + q.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_") + "%"
    scope = f"/files/{nc_user}/{path.strip('/')}".rstrip("/")
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:basicsearch>
    <d:select><d:prop>
      <d:displayname/><d:resourcetype/><d:getcontentlength/><d:getlastmodified/>
    </d:prop></d:select>
    <d:from><d:scope><d:href>{_xml_escape(scope)}</d:href><d:depth>infinity</d:depth></d:scope></d:from>
    <d:where><d:like>
      <d:prop><d:displayname/></d:prop>
      <d:literal>{_xml_escape(pattern)}</d:literal>
    </d:like></d:where>
    <d:orderby/>
    <d:limit><d:nresults>{limit}</d:nresults></d:limit>
  </d:basicsearch>
</d:searchrequest>"""
    url = f"{NEXTCLOUD_INTERNAL_URL.rstrip('/')}/remote.php/dav"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await _dav_request(
            client, "SEARCH", url,
            headers={**_auth_header(nc_user, nc_pass), "Content-Type": "text/xml"},
            content=body,
        )
    if resp.status_code not in (200, 207):
        raise HTTPException(status_code=502, detail=f"Nextcloud SEARCH: {resp.status_code}")
    results = _parse_propfind(resp.content, nc_user, "")
    for r in results:
        r["source"] = "nextcloud"
    return {"query": q, "truncated": len(results) >= limit, "results": results[:limit]}


async def _sftp_search(src: dict, q: str, path: str, limit: int) -> dict:
    import asyncio
    import time as _time
    ql = q.lower()
    start = _time.time()
    max_dirs, max_seconds = 500, 15.0
    results: list[dict] = []
    queue: list[str] = [path or "/"]
    visited = 0
    truncated = False
    source_id = f"sftp:{src.get('lan_ip', src['host'])}"
    try:
        while queue:
            if len(results) >= limit or visited >= max_dirs or (_time.time() - start) > max_seconds:
                truncated = True
                break
            current = queue.pop(0)
            visited += 1
            try:
                children = await sftp_client.list_dir(
                    src["host"], src["port"], src["user"], current, key_path=src.get("key_path"),
                )
            except Exception:  # noqa: BLE001 — skip individual unreadable folders
                continue
            for c in children:
                if ql in c["name"].lower():
                    c["source"] = source_id
                    results.append(c)
                    if len(results) >= limit:
                        break
                if c.get("isDir"):
                    queue.append(c["path"])
            await asyncio.sleep(0)  # stay cooperative
    except Exception as e:  # connection dropped or similar
        logger.error("SFTP search %s failed: %s", src["host"], e)
        raise HTTPException(status_code=502, detail=f"SFTP-Suche fehlgeschlagen: {e}")
    return {"query": q, "truncated": truncated, "results": results[:limit]}
