"""Personal browsers in a cell — talks to the cell's browser controller.

In a cell nothing is provisioned by hand: the user's browser is created the first
time the tile is opened (deploy/cell/browser/ctl.py) and lives in its own network
that only Caddy and this API join. Addresses are container names, not host ports:
    ubd-<user>:3000 (stream)  ubd-<user>:9223 (CDP)   — desktop
    ubm-<user>:3000           ubm-<user>:9223         — mobile
The controller caps how many browsers run at once; the reaper here stops the ones
nobody is connected to.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import socket

import httpx

from betriebsprofil import IS_CELL

logger = logging.getLogger(__name__)

CTL_URL = os.environ.get("BROWSER_CTL_URL", "").rstrip("/")
CTL_TOKEN = os.environ.get("BROWSER_CTL_TOKEN", "")
BASE_DOMAIN = os.environ.get("CLARAOS_BASE_DOMAIN", "")
ENABLED = bool(IS_CELL and CTL_URL and CTL_TOKEN and BASE_DOMAIN)
USER_RE = re.compile(r"^[a-z][a-z0-9._-]{1,31}$")   # = user_admin._USERNAME_RE = ctl.USER_RE
PREFIX = {"desktop": "ubd", "mobile": "ubm"}


def entry_for(username: str) -> dict | None:
    """Registry-shaped entry for routers/apps.py (container names instead of ports)."""
    if not ENABLED or not USER_RE.match(username or ""):
        return None
    return {
        "username": username, "managed": True, "cell": True,
        "desktop_ctr": f"ubd-{username}", "mobile_ctr": f"ubm-{username}",
        "desktop_host": f"browser.{BASE_DOMAIN}", "mobile_host": f"browser-m.{BASE_DOMAIN}",
    }


def endpoints(entry: dict, form: str) -> tuple[str, str, str]:
    """(internal_url, public_url, cdp_url) — reachable because the API is attached
    to every user's browser network.

    Warning: CDP by IP, not by name. Chromium refuses DevTools HTTP requests whose
    Host header is neither an IP address nor localhost ("Host header is specified
    and is not an IP address or localhost", DNS-rebinding protection) — so the
    container name is resolved here, at call time (the IP changes on restart)."""
    ctr = entry["mobile_ctr"] if form == "mobile" else entry["desktop_ctr"]
    host = entry["mobile_host"] if form == "mobile" else entry["desktop_host"]
    try:
        cdp_host = socket.gethostbyname(ctr)
    except OSError:
        cdp_host = ctr          # not running — the call fails either way
    return f"http://{ctr}:3000", f"https://{host}", f"http://{cdp_host}:9223"


async def wecken(username: str, form: str = "desktop", sekunden: int = 60) -> bool:
    """Make sure the user's browser runs and its CDP answers (for Clara's tools)."""
    if await ensure(username, form) != "ok":
        return False
    entry = entry_for(username)
    for _ in range(sekunden // 2):
        cdp = endpoints(entry, form)[2]
        try:
            async with httpx.AsyncClient(timeout=3) as c:
                if (await c.get(f"{cdp}/json/version")).status_code == 200:
                    return True
        except httpx.HTTPError:
            pass
        await asyncio.sleep(2)
    return False


async def _call(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    try:
        # Creating a browser for the first time takes a few seconds (docker run).
        async with httpx.AsyncClient(timeout=90) as client:
            r = await client.request(method, f"{CTL_URL}{path}", json=body,
                                     headers={"X-Browser-Ctl-Token": CTL_TOKEN})
        return r.status_code, (r.json() if r.content else {})
    except Exception as exc:  # noqa: BLE001 — the controller being down must not crash the API
        logger.warning("browser-ctl %s %s: %s", method, path, exc)
        return 0, {}


async def ensure(username: str, form: str) -> str:
    """'ok' | 'busy' (all slots taken) | 'error'."""
    # The browser's own narrow upload key (never the service token): downloads go
    # into this user's Files and nowhere else.
    try:
        from routers.browser_ablage import key_for
        upload_key = key_for(username)
    except Exception:  # noqa: BLE001 — without a key, downloads simply stay in the browser
        upload_key = ""
    status, data = await _call("POST", "/ensure",
                               {"user": username, "form": form, "upload_key": upload_key})
    if status == 200 and data.get("ok"):
        return "ok"
    if status == 429:
        return "busy"
    logger.warning("browser ensure %s/%s: HTTP %s %s", username, form, status, str(data)[:160])
    return "error"


async def remove(username: str) -> bool:
    """Delete the user's browsers, profiles and network (account deletion)."""
    if not ENABLED or not USER_RE.match(username or ""):
        return False
    status, data = await _call("POST", "/remove", {"user": username})
    return status == 200 and bool(data.get("ok"))


async def reap(touch, last_seen_older_than) -> int:
    """Stop browsers nobody is connected to and that were not used recently.

    `touch(user)` records activity, `last_seen_older_than(user)` says whether the
    idle period is over. A browser with an open stream/relay connection counts as
    in use — opening the tile alone is no signal for hours of streaming."""
    if not ENABLED:
        return 0
    status, data = await _call("GET", "/running")
    if status != 200:
        return 0
    stopped = 0
    for b in data.get("running", []):
        user, form = b.get("user", ""), b.get("form", "desktop")
        if b.get("active"):
            await touch(user)
        elif await last_seen_older_than(user):
            s, d = await _call("POST", "/stop", {"user": user, "form": form})
            stopped += s == 200
            logger.info("browser reaper: %s/%s gestoppt", user, form)
    return stopped
