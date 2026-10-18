"""Immich reading tools for Clara in a cell: find photos, list albums and people.

A pass-through would hand the agent Immich's full asset objects (EXIF, thumbnails,
hashes — several kilobytes each); this route returns a compact line per photo with
a link the user can open.

Identity: the tool gateway (`routers/clara_tools.py`, `per_user: true`) sends the
CALLER's own Immich key as `x-api-key`; this route forwards only that header. The
key is created by the cell (services/zellen_zugaenge.py) and is read-only — what
Immich shows that key is exactly what the user sees in their own library.
"""
from __future__ import annotations

import os
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth import require_caller

IMMICH_URL = os.environ.get("IMMICH_INTERNAL_URL", "http://immich-server:2283").rstrip("/")
BASE_DOMAIN = os.environ.get("CLARAOS_BASE_DOMAIN", "")
_TIMEOUT = 30.0

router = APIRouter(prefix="/api/claraos/immich", tags=["immich"])


def _client() -> httpx.AsyncClient:
    """HTTP client towards Immich (a seam for tests)."""
    return httpx.AsyncClient(base_url=f"{IMMICH_URL}/api", timeout=_TIMEOUT)


def _key(request: Request) -> dict[str, str]:
    require_caller(request)
    key = request.headers.get("x-api-key", "")
    if not key:
        raise HTTPException(409, "Kein Immich-Zugang für diesen Nutzer.")
    return {"x-api-key": key}


async def _immich(method: str, pfad: str, h: dict, **kw) -> Any:
    async with _client() as c:
        r = await c.request(method, pfad, headers=h, **kw)
    if r.status_code in (401, 403):
        # 401 lets the gateway renew a stale key once
        raise HTTPException(r.status_code, "Immich lehnt den Zugang ab.")
    if r.status_code >= 400:
        raise HTTPException(502, f"Immich: HTTP {r.status_code}")
    return r.json()


def _foto(a: dict) -> dict:
    exif = a.get("exifInfo") or {}
    ort = ", ".join(x for x in (exif.get("city"), exif.get("country")) if x)
    return {
        "id": a.get("id"),
        "datei": a.get("originalFileName"),
        "aufgenommen": (a.get("localDateTime") or a.get("fileCreatedAt") or "")[:16],
        "typ": "Video" if a.get("type") == "VIDEO" else "Foto",
        **({"ort": ort} if ort else {}),
        **({"personen": [p["name"] for p in a.get("people") or [] if p.get("name")]}
           if any(p.get("name") for p in a.get("people") or []) else {}),
        **({"link": f"https://immich.{BASE_DOMAIN}/photos/{a.get('id')}"} if BASE_DOMAIN else {}),
    }


class Suche(BaseModel):
    beschreibung: str | None = Field(default=None, max_length=300)
    von: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    bis: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    ort: str | None = Field(default=None, max_length=100)
    person: str | None = Field(default=None, max_length=100)
    anzahl: int = Field(default=10, ge=1, le=50)


@router.post("/suche")
async def suche(body: Suche, request: Request) -> dict:
    """Photos of the user: by description (smart search) and/or date, place, person.
    Without a description: newest first."""
    h = _key(request)
    filter_: dict[str, Any] = {"size": body.anzahl, "withExif": True, "withPeople": True}
    if body.von:
        filter_["takenAfter"] = f"{body.von}T00:00:00.000Z"
    if body.bis:
        filter_["takenBefore"] = f"{body.bis}T23:59:59.999Z"
    if body.ort:
        filter_["city"] = body.ort
    if body.person:
        treffer = await _immich("GET", "/search/person", h, params={"name": body.person})
        ids = [p["id"] for p in treffer or []]
        if not ids:
            return {"anzahl": 0, "fotos": [], "hinweis": f"Keine Person „{body.person}“ in Immich."}
        filter_["personIds"] = ids[:1]
    if body.beschreibung:
        d = await _immich("POST", "/search/smart", h, json={**filter_, "query": body.beschreibung})
    else:
        d = await _immich("POST", "/search/metadata", h, json={**filter_, "order": "desc"})
    items = ((d or {}).get("assets") or {}).get("items") or []
    return {"anzahl": len(items), "fotos": [_foto(a) for a in items]}


@router.get("/alben")
async def alben(request: Request) -> dict:
    h = _key(request)
    d = await _immich("GET", "/albums", h)
    return {"alben": [{"id": a.get("id"), "name": a.get("albumName"), "fotos": a.get("assetCount"),
                       "von": (a.get("startDate") or "")[:10], "bis": (a.get("endDate") or "")[:10],
                       "geteilt": bool(a.get("shared"))} for a in d or []]}


@router.get("/personen")
async def personen(request: Request) -> dict:
    h = _key(request)
    d = await _immich("GET", "/people", h, params={"withHidden": "false", "size": 200})
    return {"personen": [{"id": p.get("id"), "name": p.get("name")}
                         for p in (d or {}).get("people") or [] if p.get("name")]}


@router.get("/statistik")
async def statistik(request: Request) -> dict:
    h = _key(request)
    return await _immich("GET", "/assets/statistics", h)
