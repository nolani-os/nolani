"""User preferences and desktop state endpoints.

Primary storage: PostgreSQL (fast, real-time).
Secondary: Nextcloud WebDAV (cross-device roaming backup).
"""

import asyncio
import json
import logging
from fastapi import APIRouter, Request
from auth import get_current_user
from database import user_tx
from models import UserPrefs, DesktopState

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/prefs", tags=["preferences"])

DEFAULT_PREFS = UserPrefs()


@router.get("")
async def get_prefs(request: Request) -> dict:
    """Get user preferences (skin, theme, wallpaper, pinned apps).

    `stored` distinguishes real user values from defaults: without a DB row (or
    on a DB error) the response carries `stored: false` — the frontend must then
    NOT overwrite its local IndexedDB state (otherwise the skin gets reset).
    """
    user = get_current_user(request)
    try:
        async with user_tx(user["username"]) as conn:
            row = await conn.fetchrow(
                "SELECT prefs FROM claraos_user_prefs WHERE username = $1",
                user["username"],
            )
        if row and row["prefs"]:
            return {**UserPrefs(**json.loads(row["prefs"])).model_dump(), "stored": True}
    except Exception as e:
        logger.warning("prefs GET failed for %s: %s", user["username"], e)
    return {**DEFAULT_PREFS.model_dump(), "stored": False}


@router.put("")
async def save_prefs(request: Request, prefs: UserPrefs) -> dict:
    """Save user preferences (partial update).

    Merge instead of full replacement: only fields set in the body overwrite the
    stored state. This way the shell's prefs sync (skin/theme/wallpaper/pins)
    does not clobber fields owned by other writers such as desktop_icons.
    """
    user = get_current_user(request)
    try:
        incoming = prefs.model_dump(exclude_unset=True)
        # One transaction: read-merge-write cannot interleave with another tab.
        async with user_tx(user["username"]) as conn:
            row = await conn.fetchrow(
                "SELECT prefs FROM claraos_user_prefs WHERE username = $1 FOR UPDATE",
                user["username"],
            )
            existing = json.loads(row["prefs"]) if row and row["prefs"] else {}
            merged = UserPrefs(**{**existing, **incoming})
            await conn.execute(
                """
                INSERT INTO claraos_user_prefs (username, prefs, updated_at)
                VALUES ($1, $2, NOW())
                ON CONFLICT (username) DO UPDATE SET prefs = $2, updated_at = NOW()
                """,
                user["username"],
                merged.model_dump_json(),
            )
        return {"status": "ok"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.get("/desktop-state")
async def get_desktop_state(request: Request) -> DesktopState:
    """Get saved desktop state (window positions, open apps)."""
    user = get_current_user(request)
    try:
        async with user_tx(user["username"]) as conn:
            row = await conn.fetchrow(
                "SELECT state FROM claraos_desktop_state WHERE username = $1",
                user["username"],
            )
        if row and row["state"]:
            return DesktopState(**json.loads(row["state"]))
    except Exception:
        pass
    return DesktopState()


@router.put("/desktop-state")
async def save_desktop_state(request: Request, state: DesktopState) -> dict:
    """Save desktop state to DB and async-backup to Nextcloud."""
    user = get_current_user(request)
    try:
        async with user_tx(user["username"]) as conn:
            await conn.execute(
                """
                INSERT INTO claraos_desktop_state (username, state, updated_at)
                VALUES ($1, $2, NOW())
                ON CONFLICT (username) DO UPDATE SET state = $2, updated_at = NOW()
                """,
                user["username"],
                state.model_dump_json(),
            )
        # Fire-and-forget Nextcloud backup (don't block the response)
        asyncio.create_task(_nc_backup_state(user["username"], state.model_dump_json()))
        return {"status": "ok"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


async def _nc_backup_state(username: str, state_json: str) -> None:
    """Backup desktop state to Nextcloud ClaraOS/Desktop/state.json (best-effort)."""
    try:
        from routers.files import _nc_credentials, _webdav_url, _auth_header
        import httpx

        nc_user, nc_pass = await _nc_credentials(username)
        headers = {**_auth_header(nc_user, nc_pass), "Content-Type": "application/json"}

        # Ensure ClaraOS/Desktop/ directory exists
        for folder in ["ClaraOS", "ClaraOS/Desktop"]:
            url = _webdav_url(nc_user, f"/{folder}")
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.request("MKCOL", url, headers=_auth_header(nc_user, nc_pass))

        # Write state.json
        url = _webdav_url(nc_user, "/ClaraOS/Desktop/state.json")
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.put(url, headers=headers, content=state_json.encode())
    except Exception as e:
        logger.debug("NC state backup failed for %s: %s", username, e)
