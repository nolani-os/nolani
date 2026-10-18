"""Settings service endpoints.

Thin layer over settings_schema.py (the single source of truth for keys/types/defaults):

  GET    /api/claraos/settings/schema          → categories + modules (filtered by role)
  GET    /api/claraos/settings/diff            → {module: [changed keys]} in one request
  GET    /api/claraos/settings/{module}        → effective values + isDefault per key
  PUT    /api/claraos/settings/{module}        → partial update; unknown key = 422
  DELETE /api/claraos/settings/{module}        → reset module to defaults (delete rows)
  DELETE /api/claraos/settings/{module}/{key}  → reset a single key
  WS     /api/claraos/settings/ws              → settings.changed {module, keys} to
                                                 all connections of the same user

Persistence is a delta store (claraos_user_settings, migrations/015): value == default
→ the row is DELETED instead of written (KDE model, reset = remove the key).
"""

from betriebsprofil import OWNER_USER  # owner/admin account of this installation
import asyncio
import hmac
import json
import logging

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect

import settings_schema as ss
from auth import ENFORCE, PROXY_SECRET, SERVICE_TOKEN, get_current_user
from database import get_pool, user_tx

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/settings", tags=["settings"])

_tables_ready = False


async def _ensure_tables() -> None:
    """Idempotent safety net like planner._ensure_tables; the canonical schema is migrations/015."""
    global _tables_ready
    if _tables_ready:
        return
    pool = await get_pool()
    await pool.execute(
        """
        CREATE TABLE IF NOT EXISTS claraos_user_settings (
            username   TEXT NOT NULL,
            module     TEXT NOT NULL,
            key        TEXT NOT NULL,
            value      JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_by TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (username, module, key)
        )
        """
    )
    _tables_ready = True


async def _load_deltas(username: str, module_id: str) -> dict:
    async with user_tx(username) as conn:
        rows = await conn.fetch(
            "SELECT key, value FROM claraos_user_settings WHERE username=$1 AND module=$2",
            username, module_id,
        )
    return {r["key"]: json.loads(r["value"]) for r in rows}


# ── One-time migration of the legacy files_app prefs block ────────────────
# The block in claraos_user_prefs is left untouched (rollback: an older
# frontend build still reads it); the marker prevents a later prefs change
# from migrating again and overwriting new settings.
_FILES_LEGACY_KEYMAP = {
    "view_mode": "viewMode",
    "sort_key": "sortKey",
    "sort_dir": "sortDir",
    "dirs_first": "dirsFirst",
    "show_hidden": "showHidden",
    "group_by": "groupBy",
    "open_with_overrides": "openWithOverrides",
}
_MIGRATION_MARKER = "__legacy_migrated"


async def _migrate_legacy_files_prefs(username: str) -> None:
    async with user_tx(username) as conn:
        await _migrate_legacy_files_prefs_tx(conn, username)


async def _migrate_legacy_files_prefs_tx(conn, username: str) -> None:
    done = await conn.fetchval(
        "SELECT 1 FROM claraos_user_settings WHERE username=$1 AND module='files' AND key=$2",
        username, _MIGRATION_MARKER,
    )
    if done:
        return
    module = ss.get_module("files")
    row = await conn.fetchval(
        "SELECT prefs FROM claraos_user_prefs WHERE username=$1", username
    )
    legacy = {}
    try:
        legacy = (json.loads(row) if row else {}).get("files_app") or {}
    except (TypeError, ValueError):
        pass
    for old_key, new_key in _FILES_LEGACY_KEYMAP.items():
        if old_key not in legacy:
            continue
        sdef = module.setting(new_key)
        value = legacy[old_key]
        try:
            value = sdef.validate(value)
        except ValueError:
            logger.warning("files-Migration: %s=%r für %s verworfen (ungültig)",
                           old_key, value, username)
            continue
        if ss.is_default(module, new_key, value):
            continue
        # DO NOTHING: if the user already wrote to the new store, that value wins.
        await conn.execute(
            """
            INSERT INTO claraos_user_settings (username, module, key, value, updated_at, updated_by)
            VALUES ($1, 'files', $2, $3, NOW(), 'migration')
            ON CONFLICT (username, module, key) DO NOTHING
            """,
            username, new_key, json.dumps(value),
        )
    await conn.execute(
        """
        INSERT INTO claraos_user_settings (username, module, key, value, updated_at, updated_by)
        VALUES ($1, 'files', $2, 'true', NOW(), 'migration')
        ON CONFLICT (username, module, key) DO NOTHING
        """,
        username, _MIGRATION_MARKER,
    )


def _require_module(module_id: str, role: str) -> ss.SettingsModule:
    module = ss.get_module(module_id)
    if module is None:
        raise HTTPException(status_code=404, detail=f"Unbekanntes Settings-Modul: {module_id}")
    if ss.ROLE_RANK.get(role, 0) < ss.ROLE_RANK.get(module.required_role, 0):
        raise HTTPException(status_code=403, detail="Keine Berechtigung für dieses Modul.")
    return module


@router.get("/schema")
async def get_schema(request: Request) -> dict:
    user = get_current_user(request)
    return ss.schema_payload(user["role"])


@router.get("/diff")
async def get_diff(request: Request) -> dict:
    """All deviations from the defaults in ONE request (sidebar badges)."""
    user = get_current_user(request)
    await _ensure_tables()
    async with user_tx(user["username"]) as conn:
        rows = await conn.fetch(
            "SELECT module, key FROM claraos_user_settings WHERE username=$1",
            user["username"],
        )
    out: dict[str, list[str]] = {}
    for r in rows:
        module = ss.get_module(r["module"])
        # do not report orphaned rows (module/key removed from the schema) as a diff
        if module is not None and module.setting(r["key"]) is not None:
            out.setdefault(r["module"], []).append(r["key"])
    return {"changed": out}


@router.get("/{module_id}")
async def get_module_values(module_id: str, request: Request) -> dict:
    user = get_current_user(request)
    module = _require_module(module_id, user["role"])
    await _ensure_tables()
    if module_id == "files":
        await _migrate_legacy_files_prefs(user["username"])
    deltas = await _load_deltas(user["username"], module_id)
    values = ss.resolve(module, deltas)
    return {
        "module": module_id,
        "values": values,
        "isDefault": {k: k not in deltas for k in values},
    }


@router.put("/{module_id}")
async def put_module_values(module_id: str, request: Request, payload: dict) -> dict:
    user = get_current_user(request)
    module = _require_module(module_id, user["role"])
    if not isinstance(payload, dict) or not payload:
        raise HTTPException(status_code=422, detail="Leeres oder ungültiges Payload.")

    try:
        validated, unknown = ss.validate_payload(module, payload)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    if unknown:
        # Unlike models.py: NEVER silently drop unknown keys.
        raise HTTPException(
            status_code=422,
            detail=f"Unbekannte Settings-Keys für '{module_id}': {', '.join(unknown)}",
        )

    await _ensure_tables()
    # Audit: make impersonation visible (admin view sets the header)
    impersonator = request.headers.get("X-Claraos-Impersonator", "")
    changed: list[str] = []
    async with user_tx(user["username"]) as conn:
        for key, value in validated.items():
            if ss.is_default(module, key, value):
                await conn.execute(
                    "DELETE FROM claraos_user_settings WHERE username=$1 AND module=$2 AND key=$3",
                    user["username"], module_id, key,
                )
            else:
                await conn.execute(
                    """
                    INSERT INTO claraos_user_settings (username, module, key, value, updated_at, updated_by)
                    VALUES ($1, $2, $3, $4, NOW(), $5)
                    ON CONFLICT (username, module, key)
                    DO UPDATE SET value=$4, updated_at=NOW(), updated_by=$5
                    """,
                    user["username"], module_id, key, json.dumps(value), impersonator,
                )
            changed.append(key)
    if impersonator:
        logger.info("settings PUT by impersonator=%s for user=%s module=%s keys=%s",
                    impersonator, user["username"], module_id, changed)
    await _broadcast(user["username"], module_id, changed)
    return {"status": "ok", "changed": changed}


@router.delete("/{module_id}")
async def reset_module(module_id: str, request: Request) -> dict:
    user = get_current_user(request)
    module = _require_module(module_id, user["role"])
    await _ensure_tables()
    # Internal markers (__…, e.g. the files migration marker) survive the
    # reset — otherwise the next GET would migrate the legacy prefs again and
    # "reset to defaults" would silently revive old values.
    async with user_tx(user["username"]) as conn:
        await conn.execute(
            "DELETE FROM claraos_user_settings WHERE username=$1 AND module=$2 AND key NOT LIKE '\\_\\_%'",
            user["username"], module_id,
        )
    keys = [s.key for s in module.settings]
    await _broadcast(user["username"], module_id, keys)
    return {"status": "ok", "reset": keys}


@router.delete("/{module_id}/{key}")
async def reset_key(module_id: str, key: str, request: Request) -> dict:
    user = get_current_user(request)
    module = _require_module(module_id, user["role"])
    if module.setting(key) is None:
        raise HTTPException(status_code=422, detail=f"Unbekannter Key: {key}")
    await _ensure_tables()
    async with user_tx(user["username"]) as conn:
        await conn.execute(
            "DELETE FROM claraos_user_settings WHERE username=$1 AND module=$2 AND key=$3",
            user["username"], module_id, key,
        )
    await _broadcast(user["username"], module_id, [key])
    return {"status": "ok", "reset": [key]}


# ── WS back channel: settings.changed to other windows/devices of the same user ──

_ws_clients: dict[str, set[WebSocket]] = {}
_ws_lock = asyncio.Lock()


def _ws_authed_username(ws: WebSocket) -> str:
    """Fail-closed variant of the terminal pattern: accept the header only if the
    request provably came through the reverse proxy (proxy secret) or a service."""
    username = (ws.headers.get("x-authentik-username") or "").lower()
    if not ENFORCE:
        return username or OWNER_USER
    proxy_ok = PROXY_SECRET and hmac.compare_digest(
        ws.headers.get("x-claraos-proxy-secret", ""), PROXY_SECRET)
    service_ok = SERVICE_TOKEN and hmac.compare_digest(
        ws.headers.get("x-claraos-service-token", ""), SERVICE_TOKEN)
    if not (proxy_ok or service_ok):
        return ""
    return username


async def _broadcast(username: str, module_id: str, keys: list[str],
                     _from_bus: bool = False) -> None:
    # Relay to other instances via pg_bus
    if not _from_bus:
        from services import pg_bus
        await pg_bus.publish("settings.changed", {"u": username, "m": module_id, "k": keys})
    async with _ws_lock:
        clients = list(_ws_clients.get(username, ()))
    if not clients:
        return
    msg = json.dumps({"type": "settings.changed", "module": module_id, "keys": keys})
    for ws in clients:
        try:
            await ws.send_text(msg)
        except Exception:
            async with _ws_lock:
                _ws_clients.get(username, set()).discard(ws)


@router.websocket("/ws")
async def settings_ws(websocket: WebSocket) -> None:
    username = _ws_authed_username(websocket)
    if not username:
        await websocket.close(code=4401)
        return
    await websocket.accept()
    async with _ws_lock:
        _ws_clients.setdefault(username, set()).add(websocket)
    try:
        while True:
            # The client sends nothing relevant; receiving keeps the connection
            # open and detects disconnects.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        async with _ws_lock:
            _ws_clients.get(username, set()).discard(websocket)


# Bus handler: deliver settings.changed from other instances locally
async def _bus_settings_changed(data: dict) -> None:
    await _broadcast(data.get("u", ""), data.get("m", ""), data.get("k") or [], _from_bus=True)

from services import pg_bus as _pg_bus  # noqa: E402
_pg_bus.register("settings.changed", _bus_settings_changed)
