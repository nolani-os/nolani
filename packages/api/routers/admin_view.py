"""Admin view v2 — full impersonation through a server-side browser.

Approach ("log in inside the stream"):
Instead of rewriting the Authentik headers only for claraos-api (the admin-view.py
middleware, which covers ONLY the ClaraOS UI), we open an ISOLATED incognito
context (own cookie jar) in the existing Selkies browser and navigate it to the
target user's Authentik page. The admin signs in AS THEMSELF inside the stream
and clicks "Impersonate". From then on the Authentik session carries into ALL
apps (including OIDC apps such as Nextcloud/Immich).

Why an incognito context rather than a dedicated container:
- own cookie jar, isolated from the browser's main profile (the owner's
  personal service logins stay untouched)
- discarded WITHOUT A TRACE at session end via Target.disposeBrowserContext
- no new container / vhost / CA import / lifecycle needed

Security:
- clara-admins only
- no standing impersonation bot account: the admin uses their OWN Authentik
  credentials in the stream, and Authentik logs them by name
- the ClaraOS audit (claraos_impersonation_audit, action='admin-view') records
  which admin started/ended which full view and when
"""

from betriebsprofil import heim_default  # external cell: no silent home-server fallback
from domains_generated import BASE_DOMAIN  # cell: CLARAOS_BASE_DOMAIN
import asyncio
import json
import logging
import os
import urllib.request
from typing import Optional

import websockets
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from auth import get_current_user
from database import get_pool

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/admin-view", tags=["admin-view"])

SELKIES_CDP = heim_default("SELKIES_CDP_URL")
SELKIES_PUBLIC = heim_default("SELKIES_PUBLIC_URL", key="SELKIES_PUBLIC_URL@admin_view")
AUTHENTIK_URL = heim_default("AUTHENTIK_URL", key="AUTHENTIK_URL@admin_view")
AUTHENTIK_TOKEN = os.environ.get("AUTHENTIK_API_TOKEN", "")
AUTH_PUBLIC = os.environ.get("AUTHENTIK_PUBLIC_URL", f"https://auth.{BASE_DOMAIN}")

CDP_TIMEOUT = 12.0


def _require_admin(user: dict):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")


# ── CDP helpers ─────────────────────────────────────────────────

async def _cdp_browser_ws(username: str = "", form: str = "desktop") -> str:
    """Fetch the browser-level WebSocket debugger URL of the Selkies browser.

    With `username`, this is THAT user's personal instance, otherwise the shared
    one (transitional state). This way the admin view never looks into someone
    else's browser by accident.
    """
    if username:
        from routers.apps import cdp_url_for_user
        host = (await cdp_url_for_user(username, form)).rstrip("/")
    else:
        host = SELKIES_CDP.rstrip("/")
    def _fetch():
        return json.loads(urllib.request.urlopen(f"{host}/json/version", timeout=5).read())
    ver = await asyncio.to_thread(_fetch)
    return ver["webSocketDebuggerUrl"]


class _CDP:
    """Minimal CDP client over a browser WS connection."""
    def __init__(self, ws):
        self._ws = ws
        self._id = 0

    async def cmd(self, method: str, params: Optional[dict] = None,
                  session_id: Optional[str] = None) -> dict:
        """`session_id`: send to one attached target (Target.attachToTarget, flatten)."""
        self._id += 1
        my = self._id
        msg_out = {"id": my, "method": method, "params": params or {}}
        if session_id:
            msg_out["sessionId"] = session_id
        await self._ws.send(json.dumps(msg_out))
        while True:
            msg = json.loads(await self._ws.recv())
            if msg.get("id") == my:
                if "error" in msg:
                    raise RuntimeError(f"CDP {method}: {msg['error']}")
                return msg.get("result", {})


async def _with_cdp(fn, username: str = "", form: str = "desktop"):
    wsurl = await _cdp_browser_ws(username, form)
    async with websockets.connect(wsurl, max_size=None, open_timeout=CDP_TIMEOUT) as ws:
        return await asyncio.wait_for(fn(_CDP(ws)), timeout=CDP_TIMEOUT)


async def _authentik_user_pk(username: str) -> Optional[int]:
    if not AUTHENTIK_TOKEN:
        return None
    import httpx
    async with httpx.AsyncClient(timeout=8.0) as client:
        r = await client.get(
            f"{AUTHENTIK_URL}/api/v3/core/users/?username={username}",
            headers={"Authorization": f"Bearer {AUTHENTIK_TOKEN}"},
        )
    if r.status_code == 200 and r.json().get("results"):
        return r.json()["results"][0]["pk"]
    return None


# ── Models ──────────────────────────────────────────────────────

class StartBody(BaseModel):
    target_user: str


# ── Endpoints ───────────────────────────────────────────────────

@router.post("/start")
async def start(body: StartBody, request: Request) -> dict:
    """Open a fresh incognito context in the Selkies browser, navigate it to the
    target user's Authentik admin page and return the stream URL."""
    user = get_current_user(request)
    _require_admin(user)
    target = body.target_user.strip()
    if not target or target == user["username"]:
        raise HTTPException(status_code=400, detail="Ungültiger Ziel-User.")
    if target.startswith("ak-outpost-") or target == "akadmin":
        raise HTTPException(status_code=400, detail="Systemkonten sind nicht zulässig.")

    pk = await _authentik_user_pk(target)
    # Landing: the target user's page in the admin interface (has the Impersonate
    # button). Falls back to the user list if the PK cannot be resolved.
    landing = (f"{AUTH_PUBLIC}/if/admin/#/identity/users/{pk}" if pk
               else f"{AUTH_PUBLIC}/if/admin/#/identity/users/")

    async def _open(cdp: _CDP):
        ctx = (await cdp.cmd("Target.createBrowserContext",
                             {"disposeOnDetach": False}))["browserContextId"]
        tid = (await cdp.cmd("Target.createTarget",
                             {"url": landing, "browserContextId": ctx, "newWindow": True}))["targetId"]
        try:
            win = (await cdp.cmd("Browser.getWindowForTarget", {"targetId": tid}))["windowId"]
            await cdp.cmd("Browser.setWindowBounds",
                          {"windowId": win, "bounds": {"windowState": "maximized"}})
        except Exception as e:  # maximizing is cosmetic — the window exists anyway
            logger.warning("admin-view maximize failed: %s", e)
        return ctx, tid

    try:
        # The admin view runs in THE ADMIN'S browser, not a global one.
        context_id, target_id = await _with_cdp(_open, user.get("username", ""))
    except Exception as e:
        logger.warning("admin-view start failed: %s", e)
        raise HTTPException(status_code=502,
                            detail="Browser nicht erreichbar — läuft der Selkies-Browser?")

    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow("""
            INSERT INTO claraos_impersonation_audit
                (impersonator, target_user, action, details, ip_address)
            VALUES ($1, $2, 'admin-view', $3::jsonb, $4)
            RETURNING id, started_at
        """, user["username"], target,
             json.dumps({"context_id": context_id, "target_id": target_id, "landing": landing}),
             request.client.host if request.client else None)

    logger.info("ADMIN-VIEW START: %s → %s (ctx %s)", user["username"], target, context_id[:12])
    return {
        "status": "started",
        "session_id": str(row["id"]),
        "target_user": target,
        "stream_url": SELKIES_PUBLIC,
        "started_at": row["started_at"].isoformat(),
    }


async def _dispose(context_id: str):
    async def _do(cdp: _CDP):
        await cdp.cmd("Target.disposeBrowserContext", {"browserContextId": context_id})
    await _with_cdp(_do)


@router.post("/end")
async def end(request: Request) -> dict:
    """Discard the incognito context (cookies gone) and close the audit entry."""
    user = get_current_user(request)
    _require_admin(user)

    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT id, details FROM claraos_impersonation_audit
            WHERE impersonator = $1 AND action = 'admin-view' AND ended_at IS NULL
        """, user["username"])

    disposed = 0
    for r in rows:
        details = r["details"]
        if isinstance(details, str):  # asyncpg returns jsonb as a string
            details = json.loads(details) if details else {}
        ctx = (details or {}).get("context_id")
        if ctx:
            try:
                await _dispose(ctx)
                disposed += 1
            except Exception as e:
                logger.warning("admin-view dispose failed for ctx %s: %s", str(ctx)[:12], e)

    async with pool.acquire() as conn:
        await conn.execute("""
            UPDATE claraos_impersonation_audit SET ended_at = NOW()
            WHERE impersonator = $1 AND action = 'admin-view' AND ended_at IS NULL
        """, user["username"])

    logger.info("ADMIN-VIEW END: %s (%d Kontexte verworfen)", user["username"], disposed)
    return {"status": "ended", "disposed": disposed}


@router.get("/status")
async def status(request: Request) -> dict:
    """Active full view of the calling admin (for banner/resume)."""
    user = get_current_user(request)
    _require_admin(user)
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow("""
            SELECT id, target_user, started_at FROM claraos_impersonation_audit
            WHERE impersonator = $1 AND action = 'admin-view' AND ended_at IS NULL
            ORDER BY started_at DESC LIMIT 1
        """, user["username"])
    if not row:
        return {"active": False}
    return {
        "active": True,
        "session_id": str(row["id"]),
        "target_user": row["target_user"],
        "stream_url": SELKIES_PUBLIC,
        "started_at": row["started_at"].isoformat(),
    }
