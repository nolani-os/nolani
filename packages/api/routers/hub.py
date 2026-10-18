"""Services hub — admin CRUD for external third-party services.

Third-party services are claraos_apps rows with the manifest marker
hubService=true (type "selkies" → a click opens the Clara browser with CDP
auto-navigation). The hub creates new services as rows with created_by='hub' —
the seed upsert leaves those alone (it only touches created_by='system'), so a
new service needs NO rebuild.

Guards: everything clara-admins; mutations additionally human-only (no
service token — same pattern as assistants._require_human).
The user grid does NOT read here but via GET /apps (group gate there).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import urllib.request
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user
from database import get_pool
from services import vw_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/claraos/hub", tags=["hub"])


# ── Guards ───────────────────────────────────────────────────────────────────

def _require_admin(user: dict) -> None:
    if "clara-admins" not in (user.get("groups") or []):
        raise HTTPException(403, "Nur für Administratoren (clara-admins).")


def _require_human(request: Request) -> None:
    """Creating/changing services is a HUMAN decision: only through the
    Caddy/Authentik path, never with a service token — otherwise the runtime
    could silently slip new external targets in front of the users."""
    if request.headers.get("X-ClaraOS-Service-Token"):
        raise HTTPException(
            403, "Diese Entscheidung trifft nur ein Mensch (UI-Login), "
                 "nicht die Runtime.")


# ── Models ───────────────────────────────────────────────────────────────────

class ServiceInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    url: str
    icon: str | None = Field(default=None, max_length=8)
    iconUrl: str | None = None
    vaultItemId: str | None = None
    requiredGroups: list[str] | None = None


def _validate_url(raw: str) -> str:
    parsed = urlparse(raw.strip())
    if parsed.scheme != "https" or not parsed.hostname:
        raise HTTPException(400, "URL muss https und vollständig sein (https://…).")
    return raw.strip()


def _slug(name: str) -> str:
    s = name.lower()
    s = (s.replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss"))
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    if not s:
        raise HTTPException(400, "Aus dem Namen lässt sich keine Kennung bilden.")
    return f"svc-{s}"


def _row_view(app_id: str, enabled: bool, created_by: str, manifest: dict) -> dict:
    cfg = manifest.get("config") or {}
    return {
        "id": app_id,
        "enabled": enabled,
        "createdBy": created_by,
        "name": manifest.get("name") or app_id,
        "url": cfg.get("url") or "",
        "icon": manifest.get("icon") or "🌐",
        "iconUrl": cfg.get("iconUrl"),
        "vaultItemId": cfg.get("vaultItemId"),
        "requiredGroups": manifest.get("requiredGroups") or [],
    }


def _fetch_logo(url: str, timeout: int = 6) -> str | None:
    """Fetch the company logo once and return it as an embedded image.

    **Why embedded and not linked**: an `iconUrl` pointing at `shop.example/favicon.ico`
    would be loaded from the provider EVERY time the services hub is built. Every
    shop would learn **when and how often** the users open ClaraOS — a data leak
    nobody asked for. So: fetch once when creating, store as a data: URI in the
    manifest, never a third-party request again.

    Returns `None` ⇒ the caller keeps the emoji. A missing logo is cosmetic, not a
    reason to fail the creation.
    """
    import base64 as _b64
    from urllib.parse import urljoin

    host = urlparse(url)
    if host.scheme != "https" or not host.hostname:
        return None
    kandidaten = [urljoin(f"https://{host.hostname}", "/favicon.ico"),
                  urljoin(f"https://{host.hostname}", "/apple-touch-icon.png"),
                  urljoin(f"https://{host.hostname}", "/favicon.png")]
    for quelle in kandidaten:
        try:
            req = urllib.request.Request(quelle, headers={"User-Agent": "ClaraOS-Hub/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                if r.status != 200:
                    continue
                typ = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                if not typ.startswith("image/"):
                    continue
                # Cap: a 250 KB ICO in the manifest bloats every app list the
                # browser loads on EVERY start. Better an emoji than a sluggish UI.
                daten = r.read(65536 + 1)
                if len(daten) > 65536 or not daten:
                    continue
        except Exception:  # noqa: BLE001  (third-party servers, any error is possible)
            continue
        return f"data:{typ};base64,{_b64.b64encode(daten).decode()}"
    return None


def _build_manifest(inp: ServiceInput, app_id: str) -> dict:
    """Build the manifest server-side — marker fields are not the client's business."""
    return {
        "id": app_id,
        "name": inp.name.strip(),
        "icon": (inp.icon or "🌐").strip() or "🌐",
        "description": f"{inp.name.strip()} im Clara Browser (Dienste-Hub)",
        "type": "selkies",
        "category": "services",
        "source": "third-party",
        "activated": True,
        "showInStartMenu": False,
        "pinned": False,
        "hubService": True,
        "config": {
            "url": _validate_url(inp.url),
            **({"iconUrl": inp.iconUrl.strip()} if inp.iconUrl and inp.iconUrl.strip() else {}),
            **({"vaultItemId": inp.vaultItemId} if inp.vaultItemId else {}),
        },
        "window": {"defaultWidth": 1200, "defaultHeight": 750,
                   "minWidth": 700, "minHeight": 450},
        "permissions": [],
        "requiredGroups": inp.requiredGroups or [],
    }


# ── CRUD ─────────────────────────────────────────────────────────────────────

@router.get("/services")
async def list_services(request: Request) -> list[dict]:
    """Admin view: ALL hub services including disabled ones (the user grid
    reads GET /apps instead — group gate and overrides apply there)."""
    user = get_current_user(request)
    _require_admin(user)
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, manifest, enabled, created_by FROM claraos_apps "
            "WHERE manifest->>'hubService' = 'true' ORDER BY id")
    return [
        _row_view(r["id"], r["enabled"], r["created_by"], json.loads(r["manifest"]))
        for r in rows
    ]


@router.post("/services")
async def create_service(request: Request, body: ServiceInput) -> dict:
    user = get_current_user(request)
    _require_admin(user)
    _require_human(request)
    app_id = _slug(body.name)
    if not (body.iconUrl or "").strip():
        # Also when created by hand: fetch the logo once instead of an emoji.
        body.iconUrl = await asyncio.to_thread(_fetch_logo, body.url)
    manifest = _build_manifest(body, app_id)
    pool = await get_pool()
    async with pool.acquire() as conn:
        exists = await conn.fetchval("SELECT 1 FROM claraos_apps WHERE id = $1", app_id)
        if exists:
            raise HTTPException(409, f"Kennung „{app_id}“ existiert bereits.")
        await conn.execute(
            "INSERT INTO claraos_apps (id, manifest, enabled, created_by) "
            "VALUES ($1, $2, TRUE, 'hub')",
            app_id, json.dumps(manifest))
    return _row_view(app_id, True, "hub", manifest)


@router.post("/services/sync-vault")
async def sync_vault(request: Request) -> dict:
    """Create tiles from the vault collection of third-party services.

    **Why this is allowed**: the human decision is already made when **creating
    the vault entry** in that collection — whoever deliberately stores an account
    there wanted the service. Confirming the tile by hand afterwards was ritual,
    not protection. The control point is therefore the collection: only who may
    write there creates tiles. `_require_human` still stays — only a human may
    **trigger** the sync, not the runtime on its own.

    **Only creates, NEVER deletes or overwrites.** If an entry disappears from the
    collection, the tile stays and shows up in the comparison as an orphan —
    otherwise an accidentally moved vault entry would silently take tiles with it.
    """
    user = get_current_user(request)
    _require_admin(user)
    _require_human(request)

    collection = os.environ.get("CLARAOS_HUB_VAULT_COLLECTION", "").strip()
    if not collection:
        raise HTTPException(400, "Keine Vault-Sammlung konfiguriert "
                                 "(CLARAOS_HUB_VAULT_COLLECTION).")
    try:
        items = [it for it in vw_client.list_org_items()
                 if collection in (it.get("collectionIds") or [])]
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"Vault nicht erreichbar: {e}")

    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, manifest FROM claraos_apps "
            "WHERE manifest->>'hubService' = 'true'")
        # Idempotency via the vault item ID: WITHOUT it every call creates
        # duplicates — the most likely bug of this feature.
        belegt = {json.loads(r["manifest"]).get("config", {}).get("vaultItemId")
                  for r in rows}
        belegt.discard(None)
        vorhandene_ids = {r["id"] for r in rows}

        angelegt, uebersprungen = [], []
        for it in items:
            if it["id"] in belegt:
                uebersprungen.append({"name": it.get("name"), "grund": "hat schon eine Kachel"})
                continue
            uris = [u.get("uri") or "" for u in (it.get("login") or {}).get("uris") or []]
            url = next((u for u in uris if u.startswith("https://")), "")
            if not url:
                uebersprungen.append({"name": it.get("name"), "grund": "keine https-Adresse im Eintrag"})
                continue
            name = (it.get("name") or "").strip()
            # Parenthesised suffixes like "Shop (shop.example)" are clutter in a tile label.
            name = re.sub(r"\s*\([^)]*\)\s*$", "", name) or name
            try:
                app_id = _slug(name)
            except HTTPException:
                uebersprungen.append({"name": it.get("name"), "grund": "kein gültiger Bezeichner"})
                continue
            if app_id in vorhandene_ids:
                uebersprungen.append({"name": name, "grund": f"Kennung {app_id} existiert"})
                continue
            # Fetch the logo once — if that fails, the emoji stays.
            logo = await asyncio.to_thread(_fetch_logo, url)
            try:
                manifest = _build_manifest(
                    ServiceInput(name=name, url=url, vaultItemId=it["id"],
                                 iconUrl=logo), app_id)
            except HTTPException as e:
                uebersprungen.append({"name": name, "grund": f"URL abgelehnt ({e.detail})"})
                continue
            await conn.execute(
                "INSERT INTO claraos_apps (id, manifest, enabled, created_by) "
                "VALUES ($1, $2, TRUE, 'hub-auto')",
                app_id, json.dumps(manifest))
            vorhandene_ids.add(app_id)
            angelegt.append({"id": app_id, "name": name})

    logger.info("sync-vault: %d Kacheln angelegt, %d übersprungen",
                len(angelegt), len(uebersprungen))
    return {"created": angelegt, "skipped": uebersprungen,
            "collectionItems": len(items)}


@router.put("/services/{app_id}")
async def update_service(app_id: str, request: Request, body: ServiceInput) -> dict:
    user = get_current_user(request)
    _require_admin(user)
    _require_human(request)
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT manifest, enabled, created_by FROM claraos_apps WHERE id = $1", app_id)
        if not row or not json.loads(row["manifest"]).get("hubService"):
            raise HTTPException(404, "Dienst nicht gefunden.")
        if row["created_by"] != "hub":
            # The next lazy seed upsert would overwrite seed rows — changes to
            # them belong in app_seeds.py, not in the database.
            raise HTTPException(
                409, "System-Dienst (Seed) — Änderungen bitte in app_seeds.py.")
        manifest = _build_manifest(body, app_id)
        await conn.execute(
            "UPDATE claraos_apps SET manifest = $1, updated_at = NOW() WHERE id = $2",
            json.dumps(manifest), app_id)
    return _row_view(app_id, row["enabled"], "hub", manifest)


@router.delete("/services/{app_id}")
async def delete_service(app_id: str, request: Request) -> dict:
    user = get_current_user(request)
    _require_admin(user)
    _require_human(request)
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT manifest, created_by FROM claraos_apps WHERE id = $1", app_id)
        if not row or not json.loads(row["manifest"]).get("hubService"):
            raise HTTPException(404, "Dienst nicht gefunden.")
        if row["created_by"] != "hub":
            raise HTTPException(
                409, "System-Dienst (Seed) — deaktivieren statt löschen.")
        await conn.execute("DELETE FROM claraos_apps WHERE id = $1", app_id)
        # Admin path across all users — plain pool on purpose.
        await conn.execute("DELETE FROM claraos_user_apps WHERE app_id = $1", app_id)
    return {"status": "deleted"}


# ── Vault comparison ─────────────────────────────────────────────────────────

def _base_host(url: str) -> str:
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def _hosts_match(a: str, b: str) -> bool:
    """shop.example ↔ www2.shop.example counts as a match (suffix in both directions)."""
    if not a or not b:
        return False
    return a == b or a.endswith("." + b) or b.endswith("." + a)


@router.get("/vault-status")
async def vault_status(request: Request) -> dict:
    """Compare services ↔ vault login items. Read-only, never passwords.

    An explicit link (config.vaultItemId) is binding; in addition a domain
    heuristic over the item URIs. Items without any match end up in
    orphanItems ("vault items without a service").
    """
    user = get_current_user(request)
    _require_admin(user)

    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, manifest FROM claraos_apps "
            "WHERE manifest->>'hubService' = 'true' ORDER BY id")
    services = [(r["id"], json.loads(r["manifest"])) for r in rows]

    try:
        items = vw_client.list_items_for(
            user["username"], include_family=True, include_admin=True)
    except Exception as e:  # vault down ⇒ no comparison possible; the grid is unaffected
        raise HTTPException(503, f"Vault nicht erreichbar: {e}")

    # Show third-party services only: without a filter the tab listed ALL vault
    # entries — including internal ones that do not belong here. The criterion is
    # the Vaultwarden **collection** of third-party services (folders are out:
    # they are personal/client-side and invisible to a server-side filter).
    # The ID comes from the environment, NOT hard-coded — after a Vaultwarden move
    # the IDs change, and a fixed value would silently empty the tab. Empty ⇒ old
    # behaviour, so the filter can be switched off without deploy risk.
    hub_collection = os.environ.get("CLARAOS_HUB_VAULT_COLLECTION", "").strip()
    if hub_collection:
        # Do NOT filter the list from above: `list_items_for` only returns the
        # user's personal, family and (for admins) admin collections. The third-party services live in
        # a collection of their OWN — filtering would always give an empty result.
        # So fetch all org items directly and narrow them down to the collection.
        try:
            items = [it for it in vw_client.list_org_items()
                     if hub_collection in (it.get("collectionIds") or [])]
        except Exception as e:  # noqa: BLE001
            raise HTTPException(503, f"Vault nicht erreichbar: {e}")
        if not items:
            # A visible signal instead of an empty tab: a stale ID shows up at once.
            logger.warning("vault-status: Sammlung %s ist leer — ID veraltet?",
                           hub_collection[:8])

    def item_uris(it: dict) -> list[str]:
        return [u.get("uri") or "" for u in (it.get("login") or {}).get("uris") or []]

    matched_item_ids: set[str] = set()
    out_services = []
    for app_id, manifest in services:
        cfg = manifest.get("config") or {}
        svc_host = _base_host(cfg.get("url") or "")
        matches = []
        for it in items:
            if not it.get("id"):
                continue
            if cfg.get("vaultItemId") == it["id"]:
                matches.append({"itemId": it["id"], "itemName": it.get("name") or "?",
                                "via": "explicit"})
                matched_item_ids.add(it["id"])
                continue
            if any(_hosts_match(svc_host, _base_host(u)) for u in item_uris(it)):
                matches.append({"itemId": it["id"], "itemName": it.get("name") or "?",
                                "via": "domain"})
                matched_item_ids.add(it["id"])
        out_services.append({
            "id": app_id,
            "name": manifest.get("name") or app_id,
            "vaultItemId": cfg.get("vaultItemId"),
            "matched": matches,
        })

    orphans = [
        {
            "id": it["id"],
            "name": it.get("name") or "?",
            "username": (it.get("login") or {}).get("username"),
            "uri": next((u for u in item_uris(it) if u), None),
        }
        for it in items
        # Only login items are candidates for a service
        if it.get("id") and it.get("login") and it["id"] not in matched_item_ids
    ]

    return {"services": out_services, "orphanItems": orphans}
