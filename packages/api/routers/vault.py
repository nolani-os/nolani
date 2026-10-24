"""ClaraOS Vault API — read/write items in the user's Vaultwarden Org-Collections.

Auth via Authentik forward_auth headers (`get_current_user`). Uses Clara as the
service-account session; filters items by the caller's collection-membership
before returning. Family-Shared is shown only to members of the designated
family group (no automatic Family-Shared access).

Endpoints:
  GET    /api/claraos/vault/items                — list user's accessible items
  GET    /api/claraos/vault/item/{item_id}       — full item incl. password
  POST   /api/claraos/vault/items                — create new item
  PUT    /api/claraos/vault/item/{item_id}       — update existing
  DELETE /api/claraos/vault/item/{item_id}       — soft-delete (trash)
  GET    /api/claraos/vault/access               — diagnostic: collections user can see
"""
from __future__ import annotations

from betriebsprofil import ASSISTANT_NAME
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user
from routers.clara_tools import _trusted_caller
from services import vw_client

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/vault", tags=["vault"])


# ── helpers ────────────────────────────────────────────────────────


def _user_can_see_family(user: dict) -> bool:
    """Family-Shared is gated to team-family members + admins (clara-admins)."""
    grps = user.get("groups") or []
    return "team-family" in grps or "clara-admins" in grps


def _user_can_see_admin(user: dict) -> bool:
    return "clara-admins" in (user.get("groups") or [])


def _safe_username(s: str) -> str:
    """Match the sanitizer used by sync-daemon (Personal-{username})."""
    import re
    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9._-]+", "-", s)
    return s.strip("-") or "user"


def _user_accessible_collection_ids(user: dict) -> set[str]:
    """Return the set of collection-ids this user is allowed to read items from."""
    username = _safe_username(user["username"])
    ids = set()
    p = vw_client.get_user_collection_id(username, "personal")
    if p:
        ids.add(p)
    if _user_can_see_family(user):
        f = vw_client.get_user_collection_id(username, "family")
        if f:
            ids.add(f)
    if _user_can_see_admin(user):
        a = vw_client.get_user_collection_id(username, "admin")
        if a:
            ids.add(a)
    return ids


def _strip_secret(item: dict) -> dict:
    """Return item with login.password redacted (for list endpoints).
    Caller can fetch full item via /item/{id} for the password.
    """
    out = dict(item)
    login = dict(out.get("login") or {})
    if "password" in login:
        login["password"] = None
    out["login"] = login
    return out


# ── models ─────────────────────────────────────────────────────────


class ItemCreate(BaseModel):
    name: str = Field(..., min_length=1)
    login_username: str = ""
    login_password: str = ""
    uri: str = ""
    notes: str = ""
    kind: str = Field("personal", pattern="^(personal|family|admin)$")


class ItemUpdate(BaseModel):
    name: Optional[str] = None
    login_username: Optional[str] = None
    login_password: Optional[str] = None
    uri: Optional[str] = None
    notes: Optional[str] = None


# ── endpoints ──────────────────────────────────────────────────────


@router.get("/access")
async def vault_access(request: Request) -> dict:
    """Diagnostic: which collections the caller can read."""
    user = get_current_user(request)
    username = _safe_username(user["username"])
    return {
        "username": user["username"],
        "groups": user.get("groups") or [],
        "personal_collection": f"Personal-{username}",
        "can_see_family": _user_can_see_family(user),
        "can_see_admin": _user_can_see_admin(user),
    }


@router.get("/items")
async def list_items(request: Request) -> list[dict]:
    """List items the user can see (Personal + Family-Shared if eligible)."""
    user = get_current_user(request)
    try:
        items = vw_client.list_items_for(
            _safe_username(user["username"]),
            include_family=_user_can_see_family(user),
            include_admin=_user_can_see_admin(user),
        )
    except Exception as e:
        logger.exception("list_items failed")
        raise HTTPException(503, f"vault unavailable: {e}")
    return [_strip_secret(it) for it in items]


@router.get("/item/{item_id}")
async def get_item(request: Request, item_id: str) -> dict:
    """Return full item incl. login.password — only if user has access."""
    user = get_current_user(request)
    allowed = _user_accessible_collection_ids(user)
    if not allowed:
        raise HTTPException(403, "no accessible collections")
    item = vw_client.get_item_full(item_id)
    if not item:
        raise HTTPException(404, "item not found")
    item_colls = set(item.get("collectionIds") or [])
    if not (item_colls & allowed):
        raise HTTPException(403, "item not in your collections")
    return item


@router.post("/items")
async def create_item(request: Request, body: ItemCreate) -> dict:
    user = get_current_user(request)
    if body.kind == "family" and not _user_can_see_family(user):
        raise HTTPException(403, "no Family-Shared access")
    if body.kind == "admin" and not _user_can_see_admin(user):
        raise HTTPException(403, "no Admin-Only access")
    try:
        item = vw_client.create_item(
            username=_safe_username(user["username"]),
            name=body.name,
            login_user=body.login_username,
            login_pwd=body.login_password,
            uri=body.uri,
            notes=body.notes,
            kind=body.kind,
        )
    except Exception as e:
        logger.exception("create_item failed")
        raise HTTPException(503, f"create failed: {e}")
    return _strip_secret(item)


@router.put("/item/{item_id}")
async def update_item(request: Request, item_id: str, body: ItemUpdate) -> dict:
    user = get_current_user(request)
    allowed = _user_accessible_collection_ids(user)
    cur = vw_client.get_item_full(item_id)
    if not cur:
        raise HTTPException(404, "item not found")
    if not (set(cur.get("collectionIds") or []) & allowed):
        raise HTTPException(403, "not in your collections")
    try:
        upd = vw_client.update_item(
            item_id,
            name=body.name,
            login_user=body.login_username,
            login_pwd=body.login_password,
            uri=body.uri,
            notes=body.notes,
        )
    except Exception as e:
        logger.exception("update_item failed")
        raise HTTPException(503, f"update failed: {e}")
    return _strip_secret(upd)


@router.delete("/item/{item_id}")
async def delete_item(request: Request, item_id: str) -> dict:
    user = get_current_user(request)
    allowed = _user_accessible_collection_ids(user)
    cur = vw_client.get_item_full(item_id)
    if not cur:
        raise HTTPException(404, "item not found")
    if not (set(cur.get("collectionIds") or []) & allowed):
        raise HTTPException(403, "not in your collections")
    ok = vw_client.delete_item(item_id)
    if not ok:
        raise HTTPException(503, "delete failed")
    return {"ok": True, "id": item_id}


# ── Clara-Chat-Tools (clara-tools.d/vault.yaml) ────────────────────
# Identity arrives unforgeably as X-Claraos-User from the claraos_modules
# bridge (clara-agent injects the authenticated chat_user; LLM arguments are
# stripped beforehand, see routers/clara_tools.py:_trusted_caller).
# Scope is STRICTLY the caller's own Personal-{user} collection: no Family/Admin
# access on the chat path, only login items (type 1). Cards/identities are
# reserved for server-side paths (payments) and never appear in chat.


def _tool_caller(request: Request) -> str:
    caller = _trusted_caller(request)
    if not caller:
        raise HTTPException(401, "no trusted caller identity")
    return _safe_username(caller)


def _personal_login_items(username: str) -> list[dict]:
    items = vw_client.list_items_for(username, include_family=False, include_admin=False)
    return [it for it in items if it.get("type") == 1]


def _item_uri(item: dict) -> str:
    uris = (item.get("login") or {}).get("uris") or []
    return (uris[0].get("uri") or "") if uris else ""


def _match_login_item(username: str, name: str) -> dict:
    """Resolve a login item by name within the caller's Personal collection.
    Exact match (case-insensitive) first, then unique substring. Ambiguity → 409
    with candidate names (no secrets); miss → 404. Never leaks whether the name
    exists in someone ELSE's collection (scope is applied before matching)."""
    items = _personal_login_items(username)
    needle = name.strip().lower()
    exact = [it for it in items if (it.get("name") or "").strip().lower() == needle]
    if len(exact) == 1:
        return exact[0]
    candidates = exact or [it for it in items if needle in (it.get("name") or "").lower()]
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        raise HTTPException(
            404, f"kein Eintrag {name!r} in deinen mit {ASSISTANT_NAME} geteilten Passwörtern — "
                 "vault_list_credentials zeigt die exakten Namen")
    raise HTTPException(409, {
        "error": "ambiguous_name",
        "message": f"{len(candidates)} Einträge passen auf {name!r} — bitte exakten Namen nutzen",
        "candidates": sorted((it.get("name") or "") for it in candidates),
    })


class ToolCredentialGet(BaseModel):
    name: str = Field(..., min_length=1)


class ToolCredentialStore(BaseModel):
    name: str = Field(..., min_length=1)
    username: str = ""
    password: str = Field(..., min_length=1)
    uri: str = ""
    notes: str = ""


class ToolCredentialUpdate(BaseModel):
    name: str = Field(..., min_length=1)
    username: Optional[str] = None
    password: Optional[str] = None
    uri: Optional[str] = None
    notes: Optional[str] = None


@router.get("/tools/credentials")
async def tool_list_credentials(request: Request) -> dict:
    """Chat tool: names/usernames/URIs of the caller's Personal items, never passwords."""
    caller = _tool_caller(request)
    try:
        items = _personal_login_items(caller)
    except Exception as e:
        logger.exception("tool_list_credentials failed")
        raise HTTPException(503, f"vault unavailable: {e}")
    return {
        "user": caller,
        "collection": f"Personal-{caller}",
        "count": len(items),
        "credentials": [
            {"name": it.get("name"), "username": (it.get("login") or {}).get("username"),
             "uri": _item_uri(it)}
            for it in sorted(items, key=lambda x: (x.get("name") or "").lower())
        ],
    }


@router.post("/tools/credentials/get")
async def tool_get_credential(request: Request, body: ToolCredentialGet) -> dict:
    """Chat tool: full entry (incl. password), only from the caller's own collection."""
    caller = _tool_caller(request)
    item = _match_login_item(caller, body.name)
    full = vw_client.get_item_full(item["id"]) or item
    login = full.get("login") or {}
    logger.info("[vault-tools] get_credential %r by %s", full.get("name"), caller)
    return {
        "name": full.get("name"),
        "username": login.get("username"),
        "password": login.get("password"),
        "uri": _item_uri(full),
        "notes": full.get("notes"),
    }


@router.post("/tools/credentials/store")
async def tool_store_credential(request: Request, body: ToolCredentialStore) -> dict:
    """Chat tool: create a new entry in the caller's Personal collection."""
    caller = _tool_caller(request)
    needle = body.name.strip().lower()
    if any((it.get("name") or "").strip().lower() == needle
           for it in _personal_login_items(caller)):
        raise HTTPException(409, f"Eintrag {body.name!r} existiert schon — "
                                 "vault_update_credential zum Ändern nutzen")
    try:
        item = vw_client.create_item(
            username=caller, name=body.name, login_user=body.username,
            login_pwd=body.password, uri=body.uri, notes=body.notes, kind="personal",
        )
    except Exception as e:
        logger.exception("tool_store_credential failed")
        raise HTTPException(503, f"create failed: {e}")
    logger.info("[vault-tools] store_credential %r by %s", body.name, caller)
    return {"ok": True, "id": item.get("id"), "name": item.get("name"),
            "collection": f"Personal-{caller}"}


@router.post("/tools/credentials/update")
async def tool_update_credential(request: Request, body: ToolCredentialUpdate) -> dict:
    """Chat tool: update an existing own entry (name matching as in get)."""
    caller = _tool_caller(request)
    item = _match_login_item(caller, body.name)
    changed = {k for k in ("username", "password", "uri", "notes")
               if getattr(body, k) is not None}
    if not changed:
        raise HTTPException(422, "nichts zu ändern — mindestens ein Feld angeben")
    try:
        vw_client.update_item(
            item["id"],
            login_user=body.username, login_pwd=body.password,
            uri=body.uri, notes=body.notes,
        )
    except Exception as e:
        logger.exception("tool_update_credential failed")
        raise HTTPException(503, f"update failed: {e}")
    logger.info("[vault-tools] update_credential %r (%s) by %s",
                item.get("name"), ",".join(sorted(changed)), caller)
    return {"ok": True, "name": item.get("name"), "updated": sorted(changed)}
