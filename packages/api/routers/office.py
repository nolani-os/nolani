"""Office document generation for Clara.

Lets Clara create a NEW .docx from Markdown in the chat user's Nextcloud home
(closing a gap: Nextcloud Office documents could be viewed but not created).
The renderer is deliberately the already running Collabora CODE server
(convert-to API, LibreOffice engine): md -> HTML (python-markdown) -> docx
(coolwsd). Same availability domain as viewing: if Collabora is down, there
would be no viewer anyway.

Reached via the claraos_modules bridge (clara-tools.d/office.yaml), which
passes the chat user tamper-proof as `X-Claraos-User` (same pattern as
nc_pim.py). No `username` body field (impersonation protection). Deliberately
NO service-account fallback: without per-user NC credentials -> 409, otherwise
the document would land in the wrong home.

v1 limits: no images (img/![]() are stripped, which also protects against
SSRF since coolwsd would fetch remote URLs), no appending to existing
documents (live editing would need WOPI).
"""
from __future__ import annotations

from betriebsprofil import PRODUCT_NAME, heim_default  # external deployment: no silent home-server fallback
import logging
import os
import re
import unicodedata
from urllib.parse import quote as urlquote

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from database import user_tx
from routers.files import (
    MAX_FILE_SIZE,
    NEXTCLOUD_INTERNAL_URL,
    _auth_header,
    _nc_credentials,
    _webdav_url,
)

from auth import require_caller

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/office", tags=["office"])

COLLABORA_CONVERT_URL = heim_default("COLLABORA_CONVERT_URL").rstrip("/")

MAX_MARKDOWN_BYTES = 512 * 1024
_CONVERT_TIMEOUT = 60.0

_HTML_SHELL = """<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body {{ font-family: Calibri, Carlito, sans-serif; font-size: 11pt; }}
  h1 {{ font-size: 18pt; }} h2 {{ font-size: 14pt; }} h3 {{ font-size: 12pt; }}
  table {{ border-collapse: collapse; }}
  th, td {{ border: 1px solid #888; padding: 4px 8px; }}
</style></head><body>{body}</body></html>"""

_IMG_MD_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.I)
_FORBIDDEN_FN_RE = re.compile(r'[<>:"|?*\x00-\x1f]')


class _CreateBody(BaseModel):
    filename: str
    folder: str = "Dokumente"
    content_markdown: str
    title: str | None = None


def _caller(request: Request) -> str:
    """The authenticated user on whose behalf this call runs.

    Delegates to `auth.require_caller`, which FIRST checks the trust anchor
    (a machine's service token or the reverse proxy's secret) and only then
    returns the identity. Reading the header alone would let any device on
    the LAN or any signed-in user impersonate an arbitrary user.
    """
    return require_caller(request)


async def _per_user_creds(username: str) -> tuple[str, str]:
    """Per-user NC credentials, WITHOUT the service-account fallback of _nc_credentials.

    A document created via the service account would land in the wrong home
    and be invisible to the user; an honest 409 with instructions is better.
    """
    row = None
    if username:
        async with user_tx(username) as conn:   # row-level security (migrations/042)
            row = await conn.fetchrow(
                """
                SELECT 1 FROM claraos_app_credentials
                WHERE username = $1 AND app_id = 'nextcloud' AND is_active = TRUE
                """,
                username,
            )
    if not row:
        raise HTTPException(
            status_code=409,
            detail=(
                "Keine Nextcloud-Zugangsdaten hinterlegt — bitte in den "
                f"{PRODUCT_NAME}-Einstellungen unter App-Verbindungen speichern."
            ),
        )
    return await _nc_credentials(username)


def _sanitize_filename(raw: str, title: str | None) -> str:
    name = unicodedata.normalize("NFC", (raw or "").strip())
    if "/" in name or "\\" in name:
        raise HTTPException(status_code=422, detail="filename darf keinen Pfad enthalten")
    name = _FORBIDDEN_FN_RE.sub("", name).lstrip(".").strip()
    if not name:
        name = _FORBIDDEN_FN_RE.sub("", (title or "").strip()).lstrip(".").strip() or "Dokument"
    name = name[:120]
    if not name.lower().endswith(".docx"):
        name += ".docx"
    return name


def _sanitize_folder(raw: str) -> str:
    folder = (raw or "").strip().strip("/")
    if not folder:
        return "Dokumente"
    segments = [s.strip() for s in folder.split("/")]
    if any(s in ("", "..", ".") for s in segments):
        raise HTTPException(status_code=422, detail="folder enthält ungültige Segmente")
    return "/".join(segments)


def _markdown_to_html(md_text: str, title: str | None) -> str:
    import markdown as _markdown

    md_text = _IMG_MD_RE.sub("", md_text)
    md_text = _IMG_TAG_RE.sub("", md_text)
    if title and not md_text.lstrip().startswith("# "):
        md_text = f"# {title.strip()}\n\n{md_text}"
    body = _markdown.markdown(
        md_text, extensions=["extra", "tables", "sane_lists"]
    )
    body = _IMG_TAG_RE.sub("", body)
    return _HTML_SHELL.format(body=body)


async def _convert_html_to_docx(html: str) -> bytes:
    url = f"{COLLABORA_CONVERT_URL}/cool/convert-to/docx"
    try:
        async with httpx.AsyncClient(timeout=_CONVERT_TIMEOUT) as client:
            resp = await client.post(
                url,
                files={"data": ("input.html", html.encode("utf-8"), "text/html")},
            )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Collabora convert-to Timeout")
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Collabora nicht erreichbar — Dokumenterzeugung derzeit nicht möglich ({e})",
        )
    if resp.status_code != 200 or not resp.content.startswith(b"PK"):
        logger.warning("convert-to failed: %s %s", resp.status_code, resp.text[:200])
        raise HTTPException(
            status_code=502,
            detail=f"Collabora convert-to fehlgeschlagen (HTTP {resp.status_code})",
        )
    return resp.content


async def _ensure_folder(nc_user: str, nc_pass: str, folder: str) -> None:
    """Idempotent MKCOL, segment by segment (same pattern as files_v2.make_directory)."""
    parts = folder.split("/")
    async with httpx.AsyncClient(timeout=15.0) as client:
        for i in range(1, len(parts) + 1):
            url = _webdav_url(nc_user, "/".join(parts[:i]))
            resp = await client.request("MKCOL", url, headers=_auth_header(nc_user, nc_pass))
            if resp.status_code not in (200, 201, 405):
                raise HTTPException(
                    status_code=502,
                    detail=f"Ordner konnte nicht angelegt werden (MKCOL {resp.status_code})",
                )


async def _dedupe_name(nc_user: str, nc_pass: str, folder: str, filename: str) -> str:
    """`Name.docx` -> `Name-2.docx` ... if taken (same pattern as FileBrowserApp)."""
    body = ('<?xml version="1.0"?>'
            '<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>')
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.request(
            "PROPFIND", _webdav_url(nc_user, folder),
            headers={**_auth_header(nc_user, nc_pass), "Depth": "1",
                     "Content-Type": "application/xml"},
            content=body,
        )
    existing: set[str] = set()
    if resp.status_code in (200, 207):
        existing = {
            m.group(1).strip().lower()
            for m in re.finditer(r"<d:displayname>([^<]+)</d:displayname>", resp.text)
        }
    if filename.lower() not in existing:
        return filename
    stem, ext = filename[:-5], ".docx"
    for i in range(2, 50):
        candidate = f"{stem}-{i}{ext}"
        if candidate.lower() not in existing:
            return candidate
    raise HTTPException(status_code=409, detail="Zu viele gleichnamige Dokumente")


async def _fetch_file_id(nc_user: str, nc_pass: str, path: str) -> str:
    body = ('<?xml version="1.0"?>'
            '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">'
            '<d:prop><oc:fileid/></d:prop></d:propfind>')
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.request(
            "PROPFIND", _webdav_url(nc_user, path),
            headers={**_auth_header(nc_user, nc_pass), "Depth": "0",
                     "Content-Type": "application/xml"},
            content=body,
        )
    m = re.search(rb"<oc:fileid>(\d+)</oc:fileid>", resp.content)
    return m.group(1).decode() if m else ""


@router.post("/create-document")
async def create_document(body: _CreateBody, request: Request) -> dict:
    """Create a new .docx from Markdown in the caller's NC home."""
    caller = _caller(request)

    if len(body.content_markdown.encode("utf-8")) > MAX_MARKDOWN_BYTES:
        raise HTTPException(status_code=413, detail="content_markdown zu groß (max 512 KB)")
    filename = _sanitize_filename(body.filename, body.title)
    folder = _sanitize_folder(body.folder)

    nc_user, nc_pass = await _per_user_creds(caller)

    # Convert first, then write: no partial artifact if conversion fails.
    html = _markdown_to_html(body.content_markdown, body.title)
    docx_bytes = await _convert_html_to_docx(html)
    if len(docx_bytes) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="Erzeugtes Dokument zu groß (max 10 MB)")

    await _ensure_folder(nc_user, nc_pass, folder)
    filename = await _dedupe_name(nc_user, nc_pass, folder, filename)
    path = f"{folder}/{filename}"

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.put(
            _webdav_url(nc_user, path),
            headers={**_auth_header(nc_user, nc_pass),
                     "Content-Type": "application/octet-stream"},
            content=docx_bytes,
        )
    if resp.status_code not in (200, 201, 204):
        raise HTTPException(
            status_code=502, detail=f"Nextcloud-Upload fehlgeschlagen ({resp.status_code})"
        )

    file_id = await _fetch_file_id(nc_user, nc_pass, path)
    logger.info("office.create_document: %s → %s (%d bytes, id=%s)",
                caller, path, len(docx_bytes), file_id or "?")
    return {
        "source": "nextcloud",
        "path": path,
        "file_id": file_id,
        "filename": filename,
        "resolved_user": caller,
    }
