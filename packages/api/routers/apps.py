"""App registry endpoints – DB-driven with seed data."""

from domains_generated import LEGACY_DOMAIN
from betriebsprofil import ASSISTANT_NAME, heim_default, heim_struktur  # external cell: no silent home-server fallback
import asyncio
import json
import logging
import os
import time
from urllib.parse import quote, urlparse

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from auth import get_current_user, is_service_call, require_caller
from database import get_pool, user_tx
from app_seeds import BUILTIN_APPS
from services import zellen_browser

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/claraos/apps", tags=["apps"])

_seeded = False

SELKIES_INTERNAL = os.environ.get("SELKIES_INTERNAL_URL", "http://selkies-browser:3000")
# Public URL used by the browser to load Selkies iframe
# Must be resolvable from the user's browser (not just Docker network)
SELKIES_PUBLIC = heim_default("SELKIES_PUBLIC_URL", key="SELKIES_PUBLIC_URL@apps")
# Chrome DevTools Protocol of the Selkies Chromium (socat sidecar on an internal host).
# Full control of the browser — must only be reachable by claraos-api, never via the
# reverse proxy or from outside.
SELKIES_CDP = heim_default("SELKIES_CDP_URL")
# Mobile twin (Android UA + 2.6x scaling) — separate profile so that third-party
# service sessions stay apart from the user's private browser.
SELKIES_MOBILE_INTERNAL = heim_default("SELKIES_MOBILE_INTERNAL_URL")
SELKIES_MOBILE_PUBLIC = heim_default("SELKIES_MOBILE_PUBLIC_URL")
SELKIES_MOBILE_CDP = heim_default("SELKIES_MOBILE_CDP_URL")
# Control service for the personal instances — holds the Docker socket, which the
# API deliberately does not have. Only start/stop, only allowed container prefixes.
BROWSER_CTL_URL = heim_default("BROWSER_CTL_URL")


async def _ensure_seeded():
    """Seed builtin apps into DB on first request (upsert, don't overwrite user changes)."""
    global _seeded
    if _seeded:
        return
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claraos_apps (
                id          TEXT PRIMARY KEY,
                manifest    JSONB NOT NULL,
                enabled     BOOLEAN DEFAULT TRUE,
                created_by  TEXT,
                created_at  TIMESTAMPTZ DEFAULT NOW(),
                updated_at  TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        for app in BUILTIN_APPS:
            await conn.execute("""
                INSERT INTO claraos_apps (id, manifest, enabled, created_by)
                VALUES ($1, $2, TRUE, 'system')
                ON CONFLICT (id) DO UPDATE SET
                    manifest = CASE
                        WHEN claraos_apps.created_by = 'system' THEN $2
                        ELSE claraos_apps.manifest
                    END,
                    updated_at = NOW()
            """, app["id"], json.dumps(app))
    _seeded = True
    logger.info("Seeded %d builtin apps into DB", len(BUILTIN_APPS))


# ── STATIC ROUTES FIRST (before /{app_id} catch-all) ──

# Apps of an optional per-tenant SaaS stack (configured per installation; empty by default).
_TENANT_SAAS_APP_IDS = heim_struktur("HEIM_TENANT_APPS", frozenset())


def _tenant_from_groups(groups: list[str]) -> str | None:
    """Extract tenant name from Authentik groups (prefix 'tenant-')."""
    for g in groups or []:
        if g.startswith("tenant-"):
            return g.removeprefix("tenant-")
    return None


def _rewrite_app_for_tenant(manifest: dict, tenant: str) -> dict:
    """If app is part of SaaS stack and user has a tenant-group, rewrite iframe URL
    to <app>.<tenant>.<base domain>.
    """
    if not tenant or manifest.get("id") not in _TENANT_SAAS_APP_IDS:
        return manifest
    url = manifest.get("config", {}).get("url", "")
    legacy = "." + LEGACY_DOMAIN
    if not LEGACY_DOMAIN or not url or legacy not in url:
        return manifest
    new_url = url.replace(legacy, f".{tenant}{legacy}", 1)
    out = dict(manifest)
    out["config"] = dict(manifest["config"])
    out["config"]["url"] = new_url
    return out


def _rewrite_user_scoped_url(manifest: dict, user: dict) -> dict:
    """For apps with config.userScoped=True, substitute {user} placeholder in URL
    with the authenticated username (lowercased). Used by per-user app
    instances at e.g. <user>.<app>.<base domain>.
    """
    cfg = manifest.get("config") or {}
    if not cfg.get("userScoped"):
        return manifest
    url = cfg.get("url", "")
    username = (user.get("username") or "").lower()
    if not username or "{user}" not in url:
        return manifest
    out = dict(manifest)
    out["config"] = dict(cfg)
    out["config"]["url"] = url.replace("{user}", username)
    return out


def _sichtbar(manifest: dict, override: bool | None, username: str, groups: list[str]) -> bool:
    """May this user see this app? A per-user override wins in both directions (grant OR
    hide); otherwise the group and user-name gate. The ONE rule for tiles and Clara."""
    if override is not None:
        return override
    req_groups = manifest.get("requiredGroups") or []
    if req_groups and not any(g in groups for g in req_groups):
        return False
    req_usernames = manifest.get("requiredUsernames") or []
    return not (req_usernames and username.lower() not in [u.lower() for u in req_usernames])


@router.get("")
async def list_apps(request: Request) -> list[dict]:
    """List all apps available to the current user."""
    # Warning: authenticate BEFORE seeding. If the seed ran first, an
    # unauthenticated request would get a 401 but still trigger a database write.
    # Only fixed builtin seeds are written, so nothing leaks — but a write path
    # before authentication is exactly what "fail-closed" is meant to rule out.
    user = get_current_user(request)
    await _ensure_seeded()
    tenant = _tenant_from_groups(user.get("groups", []))
    username = user.get("username") or ""
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, manifest FROM claraos_apps WHERE enabled = TRUE ORDER BY id"
        )
    # Per-user overrides (User Admin v2): {app_id: enabled}. Overrides the
    # group gate in both directions (grant OR hide). Read under row-level
    # security for this user (migrations/042).
    ov_rows = []
    if username:
        async with user_tx(username) as conn:
            ov_rows = await conn.fetch(
                "SELECT app_id, enabled FROM claraos_user_apps WHERE username = $1", username)
    overrides = {r["app_id"]: r["enabled"] for r in ov_rows}
    apps = []
    for row in rows:
        manifest = json.loads(row["manifest"])
        if not _sichtbar(manifest, overrides.get(row["id"]), username, user["groups"]):
            continue
        manifest = _rewrite_app_for_tenant(manifest, tenant)
        manifest = _rewrite_user_scoped_url(manifest, user)
        apps.append(manifest)
    return apps


# ── Personal browser instances ─────────────────────────────────────────────
# Every user has their own streamed browser (own profile, own logins). The
# agent and co-browsing ALWAYS work against the requesting user's instance —
# there is no path into someone else's session.
# Without a registry entry everything falls back to the shared instance
# (SELKIES_* env), so setups without a registry keep working.
_ub_table_ready = False

USER_BROWSER_DDL = """
CREATE TABLE IF NOT EXISTS claraos_user_browsers (
    username TEXT NOT NULL, tenant_id BIGINT NOT NULL DEFAULT 1,
    idx INTEGER NOT NULL,
    desktop_host TEXT NOT NULL, desktop_web INTEGER NOT NULL,
    desktop_relay INTEGER NOT NULL, desktop_cdp INTEGER NOT NULL,
    desktop_ctr TEXT NOT NULL,
    mobile_host TEXT NOT NULL, mobile_web INTEGER NOT NULL,
    mobile_relay INTEGER NOT NULL, mobile_cdp INTEGER NOT NULL,
    mobile_ctr TEXT NOT NULL,
    stack_dir TEXT NOT NULL DEFAULT '', managed BOOLEAN NOT NULL DEFAULT TRUE,
    last_seen TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (username, tenant_id)
)
"""


async def _ensure_user_browser_table() -> None:
    global _ub_table_ready
    if _ub_table_ready:
        return
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(USER_BROWSER_DDL)
    _ub_table_ready = True


async def user_browser(username: str) -> dict | None:
    """The user's registry entry, or None (then the shared instance applies)."""
    if not username:
        return None
    if zellen_browser.ENABLED:
        # Cell: every user gets a browser on first use — no hand provisioning.
        entry = zellen_browser.entry_for(username)
        if entry:
            await _ensure_cell_row(username)
        return entry
    try:
        await _ensure_user_browser_table()
        pool = await get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM claraos_user_browsers WHERE username = $1", username)
        return dict(row) if row else None
    except Exception as exc:  # noqa: BLE001 — the registry must never block the browser
        logger.warning("user_browser lookup %s: %s", username, exc)
        return None


async def _ensure_cell_row(username: str) -> None:
    """Cell: a registry row only to carry `last_seen` for the reaper (no ports)."""
    try:
        await _ensure_user_browser_table()
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO claraos_user_browsers
                   (username, idx, desktop_host, desktop_web, desktop_relay, desktop_cdp, desktop_ctr,
                    mobile_host, mobile_web, mobile_relay, mobile_cdp, mobile_ctr, last_seen)
                   VALUES ($1, 0, '', 0, 0, 0, $2, '', 0, 0, 0, $3, NOW())
                   ON CONFLICT DO NOTHING""",
                username, f"ubd-{username}", f"ubm-{username}")
    except Exception as exc:  # noqa: BLE001 — never block the browser over bookkeeping
        logger.warning("cell browser row %s: %s", username, exc)


async def _registry_populated() -> bool:
    """Are there any personal instances at all (per-user mode active)?"""
    try:
        await _ensure_user_browser_table()
        pool = await get_pool()
        async with pool.acquire() as conn:
            n = await conn.fetchval("SELECT COUNT(*) FROM claraos_user_browsers")
        return bool(n)
    except Exception:  # noqa: BLE001
        return False


async def _touch_user_browser(username: str) -> None:
    """Record the last-use time (input for the idle reaper)."""
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE claraos_user_browsers SET last_seen = NOW() WHERE username = $1",
                username)
    except Exception:  # noqa: BLE001
        pass


def _endpoints_for(entry: dict | None, form: str) -> tuple[str, str, str]:
    """(internal_url, public_url, cdp_url) for 'desktop' or 'mobile'."""
    if not entry:
        if form == "mobile":
            return SELKIES_MOBILE_INTERNAL, SELKIES_MOBILE_PUBLIC, SELKIES_MOBILE_CDP
        return SELKIES_INTERNAL, SELKIES_PUBLIC, SELKIES_CDP
    if entry.get("cell"):
        return zellen_browser.endpoints(entry, form)
    host_ip = heim_default("SELKIES_USER_HOST_IP")
    if form == "mobile":
        return (f"http://{host_ip}:{entry['mobile_web']}",
                f"https://{entry['mobile_host']}",
                f"http://{host_ip}:{entry['mobile_cdp']}")
    return (f"http://{host_ip}:{entry['desktop_web']}",
            f"https://{entry['desktop_host']}",
            f"http://{host_ip}:{entry['desktop_cdp']}")


async def ensure_running(entry: dict | None, form: str) -> bool:
    """Start the instance on demand (lazy start).

    Personal browsers do NOT run permanently — two dozen containers at ~450 MB
    each would waste memory. The container is started when the tile is opened;
    the idle reaper (services/browser_reaper) stops it again.
    `managed=False` (index 0, the pre-existing instance) is never touched.
    """
    if not entry or not entry.get("managed"):
        return False
    ctr = entry["mobile_ctr"] if form == "mobile" else entry["desktop_ctr"]
    return await _ctl(ctr, "start")


async def _ctl(container: str, verb: str) -> bool:
    """Control a container through claraos-browser-ctl.

    Important: claraos-api deliberately has NO Docker socket (it is an exposed
    component). The ctl service has one, but only accepts start/stop and only
    for containers with an allowed prefix.
    """
    token = os.environ.get("CLARAOS_SERVICE_TOKEN", "")
    if not token:
        return False
    try:
        async with httpx.AsyncClient(timeout=45) as client:
            resp = await client.post(
                f"{BROWSER_CTL_URL}/{verb}",
                headers={"X-ClaraOS-Service-Token": token},
                json={"container": container})
        ok = resp.status_code == 200 and resp.json().get("ok")
        logger.info("browser-ctl %s %s: %s", verb, container,
                    "ok" if ok else resp.text[:120])
        return bool(ok)
    except Exception as exc:  # noqa: BLE001
        logger.warning("browser-ctl %s %s: %s", verb, container, exc)
        return False


async def reap_idle_browsers(idle_minutes: int = 30) -> int:
    """Stop unused personal instances (give memory back).

    Runs as a background loop (main.py). Only `managed` instances —
    index 0 (the owner's reference instance) is never touched.
    """
    if zellen_browser.ENABLED:
        async def idle_long_enough(user: str) -> bool:
            pool = await get_pool()
            async with pool.acquire() as conn:
                fresh = await conn.fetchval(
                    """SELECT last_seen >= NOW() - ($2 || ' minutes')::interval
                       FROM claraos_user_browsers WHERE username = $1""",
                    user, str(idle_minutes))
            return not fresh
        return await zellen_browser.reap(_touch_user_browser, idle_long_enough)
    stopped = 0
    try:
        await _ensure_user_browser_table()
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT username, desktop_ctr, mobile_ctr FROM claraos_user_browsers
                   WHERE managed = TRUE
                     AND (last_seen IS NULL OR last_seen < NOW() - ($1 || ' minutes')::interval)""",
                str(idle_minutes))
        for r in rows:
            for ctr in (r["desktop_ctr"], r["mobile_ctr"]):
                if await _ctl(ctr, "stop"):
                    stopped += 1
    except Exception as exc:  # noqa: BLE001
        logger.warning("reaper: %s", exc)
    return stopped


async def cdp_url_for_user(username: str, form: str = "desktop") -> str:
    """CDP endpoint of the personal instance — for other routers (e.g. admin-view).

    Without a registry entry, the shared instance. This way remote-control paths
    outside /apps also always act on the respective user's browser rather than
    on a global URL.
    """
    entry = await user_browser(username)
    return _endpoints_for(entry, form)[2]


@router.get("/selkies/status")
async def selkies_status(request: Request) -> dict:
    """Availability + URL of THE REQUESTING USER'S browser (desktop + mobile).

    The frontend (SelkiesApp) uses the returned URL as is — so every user lands
    on their own instance without the tiles having to be maintained per user.
    """
    user = get_current_user(request)
    username = user.get("username", "")
    entry = await user_browser(username)

    # As soon as the registry has entries, per-user mode applies: whoever has
    # no browser of their own gets none — otherwise the API would report
    # "available" and the user would hit the owner check in the proxy (403).
    # Empty registry = shared mode → shared instance.
    if not entry and await _registry_populated():
        return {
            "available": False,
            "url": SELKIES_PUBLIC,
            "personal": False,
            "reason": "kein_eigener_browser",
            "hint": f"Für dich ist noch kein persönlicher {ASSISTANT_NAME} Browser eingerichtet.",
            "mobile": {"available": False, "url": SELKIES_MOBILE_PUBLIC},
        }

    async def probe(url: str) -> bool:
        try:
            async with httpx.AsyncClient(timeout=3, verify=False) as client:
                resp = await client.get(f"{url}/")
                return resp.status_code < 500
        except Exception:
            return False

    if entry and entry.get("cell"):
        return await _cell_status(username, entry, request.query_params.get("form"), probe)

    d_int, d_pub, _ = _endpoints_for(entry, "desktop")
    m_int, m_pub, _ = _endpoints_for(entry, "mobile")
    if entry:
        await _touch_user_browser(user.get("username", ""))

    d_ok = await probe(d_int)
    m_ok = await probe(m_int)
    # Lazy start: if the user's instance is asleep, wake it here and wait
    # briefly — the frontend loads the iframe right after this response.
    if entry and not d_ok and await ensure_running(entry, "desktop"):
        for _ in range(10):
            await asyncio.sleep(2)
            d_ok = await probe(d_int)
            if d_ok:
                break
    if entry and not m_ok and await ensure_running(entry, "mobile"):
        for _ in range(6):
            await asyncio.sleep(2)
            m_ok = await probe(m_int)
            if m_ok:
                break
    return {
        "available": d_ok,
        "url": d_pub,
        "personal": bool(entry),
        "mobile": {"available": m_ok, "url": m_pub},
    }


async def _cell_status(username: str, entry: dict, wanted: str | None, probe) -> dict:
    """Cell: wake only the twin the client asked for (memory), report WHY not."""
    await _touch_user_browser(username)
    res: dict[str, dict] = {}
    for form in ("desktop", "mobile"):
        internal, public, _ = _endpoints_for(entry, form)
        ok = await probe(internal)
        hint = None
        if not ok and wanted in (None, form):
            state = await zellen_browser.ensure(username, form)
            if state == "ok":
                # First start of a fresh profile takes ~20-40 s.
                for _ in range(30):
                    await asyncio.sleep(2)
                    if await probe(internal):
                        ok = True
                        break
                if not ok:
                    hint = "Dein Browser startet noch — gleich noch einmal versuchen."
            elif state == "busy":
                hint = "Gerade sind alle Browser-Plätze belegt. Bitte in ein paar Minuten noch einmal versuchen."
            else:
                hint = "Dein Browser konnte nicht gestartet werden."
        res[form] = {"available": ok, "url": public, **({"hint": hint} if hint else {})}
    return {**res["desktop"], "personal": True, "mobile": res["mobile"]}


def _base_host(url: str) -> str:
    return (urlparse(url).hostname or "").removeprefix("www.").lower()


@router.post("/selkies/navigate")
async def selkies_navigate(request: Request) -> dict:
    """Open/focus an app's target URL in the shared Selkies Chromium via CDP.

    Takes an appId (never a raw URL) so callers can only navigate to URLs
    of manifests they are allowed to see (requiredGroups enforced here).
    """
    user = get_current_user(request)
    body = await request.json()
    app_id = str(body.get("appId", ""))
    await _ensure_seeded()
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT manifest FROM claraos_apps WHERE id = $1 AND enabled = TRUE", app_id
        )
    if not row:
        return {"error": "not_found"}
    manifest = json.loads(row["manifest"])
    req_groups = manifest.get("requiredGroups") or []
    if req_groups and not any(g in user.get("groups", []) for g in req_groups):
        return {"error": "forbidden"}
    url = (manifest.get("config") or {}).get("url")
    if manifest.get("type") != "selkies" or not url:
        return {"error": "no_target_url"}
    # form="mobile" → mobile twin. Important: ALWAYS the requesting user's
    # instance — the agent never navigates in someone else's session.
    entry = await user_browser(user.get("username", ""))
    form = "mobile" if body.get("form") == "mobile" else "desktop"
    _int, _pub, cdp_base = _endpoints_for(entry, form)
    if entry:
        await _touch_user_browser(user.get("username", ""))
    host = _base_host(url)
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            tabs = (await client.get(f"{cdp_base}/json/list")).json()
            for tab in tabs:
                tab_host = _base_host(tab.get("url", ""))
                if tab.get("type") == "page" and (
                    tab_host == host or tab_host.endswith("." + host)
                ):
                    await client.get(f"{cdp_base}/json/activate/{tab['id']}")
                    return {"status": "focused"}
            # PUT is mandatory since Chrome M109; the WHOLE query string is the
            # target URL (no url= parameter — otherwise about:blank opens)
            await client.put(f"{cdp_base}/json/new?{quote(url, safe=':/?&=%')}")
            return {"status": "opened"}
    except Exception as exc:
        logger.warning("selkies navigate failed for %s: %s", app_id, exc)
        return {"error": "cdp_unreachable"}


# ── Open an arbitrary URL in the Clara browser (e.g. mail links) ────────────
#
# Why separate from /selkies/navigate: that one is appId-based so the group
# permissions hang off the manifest. Here an ARBITRARY address comes in (from
# an email), so two different protection layers apply:
#   1. https only + resolvable hostname
#   2. `private` by default — an isolated browser context without cookies,
#      logins or the password extension. A phishing link finds nothing there.
#      `session` (the logged-in browser) is the deliberate exception, which
#      the shell only requests after confirmation.
# Per-user isolation follows from the per-user instances: the context is
# created in THIS user's instance.

PRIVATE_DOWNLOAD_DIR = os.environ.get(
    "CLARAOS_PRIVATE_DOWNLOAD_DIR", "/config/Downloads/claraos-privat")
# Language a private window asks for (it has no profile preferences of its own).
PRIVATE_ACCEPT_LANGUAGE = os.environ.get("CLARAOS_BROWSER_LANGUAGE", "de-DE,de;q=0.9,en;q=0.8")


class OpenUrlBody(BaseModel):
    url: str
    mode: str = "private"          # "private" | "session"
    source: str = ""               # origin, e.g. "mail" — for logging only
    # "mobile" | "desktop"; empty = the form of the shell the user connected
    # last (a phone shows the mobile twin, a page in the desktop one is invisible there)
    form: str = ""


def _validate_https(raw: str) -> str:
    """https with a hostname only (same rule as in the services hub)."""
    parsed = urlparse((raw or "").strip())
    if parsed.scheme != "https" or not parsed.hostname:
        raise HTTPException(400, "Nur https-Adressen mit vollständigem Hostnamen.")
    return raw.strip()


async def _was_geladen(cdp, target_id: str) -> dict:
    """Address and title the page REALLY ended up on — the caller's proof.

    Opening is not success: a stale link redirects to an error page, and the
    agent reported "opened the page" for a 404. The answer carries
    what loaded, so the caller can check it like any other write.
    """
    try:
        info = (await cdp.cmd("Target.getTargetInfo", {"targetId": target_id}))["targetInfo"]
        return {"final_url": info.get("url", ""), "title": info.get("title", "")}
    except Exception:  # noqa: BLE001 — the window is open either way
        return {}


async def _browser_nach_vorn(username: str, form: str | None) -> None:
    """Bring the browser tile to the front on the user's shells of that form.

    Done here, not left to the caller: the agent skipped this step now and then,
    and the page was open where nobody looked.
    """
    try:
        from routers.actions import _broadcast
        await _broadcast(username, {"type": "action", "app_id": "shell", "action": "open_window",
                                    "args": {"app_id": "selkies-browser"}, "nur_form": form,
                                    "from": "selkies-open", "ts": time.time()})
    except Exception as exc:  # noqa: BLE001 — the page is open either way
        logger.warning("browser front failed: %s", exc)


async def _relay_tab(relay_port: int, username: str, url: str, cdp_base: str) -> dict:
    """Open `url` as a kiosk tab through the browser's own relay; report what loaded."""
    from websockets.asyncio.client import connect
    host_ip = heim_default("SELKIES_USER_HOST_IP")
    async with connect(f"ws://{host_ip}:{relay_port}/claraos-cdp",
                       additional_headers={"X-Authentik-Username": username},
                       open_timeout=5) as ws:
        await ws.send(json.dumps({"id": 1, "method": "ClaraOS.tabs.create", "params": {"url": url}}))
        antwort = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
    tid = ((antwort.get("result") or {}) if isinstance(antwort.get("result"), dict) else {}).get("id")
    if not tid:
        raise RuntimeError(f"relay tabs.create: {str(antwort)[:120]}")
    await asyncio.sleep(2.5)  # redirects settle, then report (as _was_geladen)
    async with httpx.AsyncClient(timeout=5) as c:
        for tab in (await c.get(f"{cdp_base}/json/list")).json():
            if tab.get("id") == tid:
                return {"targetId": tid, "final_url": tab.get("url", ""), "title": tab.get("title", "")}
    return {"targetId": tid}


async def _wecken_und_warten(entry: dict, form: str, cdp_base: str) -> None:
    """Start a sleeping personal instance and wait until its CDP answers (max ~20 s)."""
    async def cdp_da() -> bool:
        try:
            async with httpx.AsyncClient(timeout=3) as c:
                return (await c.get(f"{cdp_base}/json/version")).status_code == 200
        except Exception:  # noqa: BLE001
            return False
    if await cdp_da() or not await ensure_running(entry, form):
        return
    for _ in range(10):
        await asyncio.sleep(2)
        if await cdp_da():
            return


@router.post("/selkies/open")
async def selkies_open(request: Request, body: OpenUrlBody) -> dict:
    """Open an arbitrary address in the Clara browser — private or logged in."""
    # require_caller, not get_current_user: Clara's tool calls name the user in
    # X-Claraos-User (with the service token) — get_current_user would fall back to
    # the service identity and open the page in nobody's browser.
    username = require_caller(request)
    url = _validate_https(body.url)
    from routers.actions import aktuelle_form  # lazy: keeps the router imports flat
    entry = await user_browser(username)
    # The twin the user LOOKS at: the browser tile (type "selkies") shows the
    # mobile twin on a phone and the desktop twin elsewhere, so the device in
    # front decides.
    geraet = aktuelle_form(username)
    form = body.form if body.form in ("mobile", "desktop") else (geraet or "desktop")
    if entry and entry.get("cell") and not await zellen_browser.wecken(username, form):
        return {"error": "browser_unavailable",
                "hint": "Der Browser konnte gerade nicht gestartet werden (alle Plätze belegt?)."}
    _int, _pub, cdp_base = _endpoints_for(entry, form)
    if entry:
        await _touch_user_browser(username)
        if not entry.get("cell"):
            await _wecken_und_warten(entry, form, cdp_base)

    # Both twins are kiosk Chromiums: their look (and on the phone touch) come
    # from a relay that serves the tabs of the KIOSK context. A private context
    # opens a separate window beside the kiosk — the page was "open" but
    # invisible, and the stray windows broke look and touch for the whole
    # browser. So when the AGENT opens a page it becomes a normal kiosk tab,
    # created by the relay itself (profile first, then navigate). The shell's
    # own private windows for mail links (a person clicked) stay as they are.
    relay_port = entry.get(f"{form}_relay") if entry and not entry.get("cell") else None
    if relay_port and is_service_call(request):
        try:
            geladen = await _relay_tab(relay_port, username, url, cdp_base)
        except Exception as exc:  # noqa: BLE001
            logger.warning("selkies open (relay) failed: %s", exc)
            return {"error": "cdp_unreachable"}
        await _browser_nach_vorn(username, geraet)
        logger.info("BROWSER-OPEN tab: %s → %s (%s, Quelle %s)",
                    username, _base_host(url), form, body.source or "—")
        return {"status": "opened", "mode": "session", "form": form,
                "hinweis": "Opened as a new tab of the user's own browser (the normal one).",
                **geladen}

    if body.mode == "session":
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                r = await client.put(f"{cdp_base}/json/new?{quote(url, safe=':/?&=%#+')}")
                # Bring the new tab to the FRONT — depending on state, Chrome may
                # otherwise open it behind the active one, and the user sees the
                # old page in the stream (looks like "nothing happened").
                geladen: dict = {}
                try:
                    tid = (r.json() or {}).get("id")
                    if tid:
                        await client.get(f"{cdp_base}/json/activate/{tid}")
                        await asyncio.sleep(2.5)  # let redirects settle, then report (_was_geladen)
                        for tab in (await client.get(f"{cdp_base}/json/list")).json():
                            if tab.get("id") == tid:
                                geladen = {"final_url": tab.get("url", ""), "title": tab.get("title", "")}
                except Exception as exc:  # noqa: BLE001 — activating is optional
                    logger.warning("selkies open: activate failed: %s", exc)
        except Exception as exc:  # noqa: BLE001
            logger.warning("selkies open (session) failed: %s", exc)
            return {"error": "cdp_unreachable"}
        await _browser_nach_vorn(username, form)
        logger.info("BROWSER-OPEN session: %s → %s (%s, Quelle %s)",
                    username, _base_host(url), form, body.source or "—")
        return {"status": "opened", "mode": "session", "form": form, **geladen}

    # ── private: own context, own download folder ──
    from routers.admin_view import _with_cdp  # lazy: admin_view imports apps

    async def _open(cdp):
        ctx = (await cdp.cmd("Target.createBrowserContext",
                             {"disposeOnDetach": False}))["browserContextId"]
        try:
            # Keep downloads of the private session separate; the relay moves
            # them from there into a dedicated Files folder.
            await cdp.cmd("Browser.setDownloadBehavior",
                          {"behavior": "allowAndName", "downloadPath": PRIVATE_DOWNLOAD_DIR,
                           "browserContextId": ctx, "eventsEnabled": True})
        except Exception as exc:  # noqa: BLE001 — downloads are optional, the window matters
            logger.warning("private download dir failed: %s", exc)
        # Blank first: a fresh context has no language preference, so sites that
        # pick the language from Accept-Language redirected to their default
        # language version. Set it, then navigate.
        tid = (await cdp.cmd("Target.createTarget",
                             {"url": "about:blank", "browserContextId": ctx,
                              "newWindow": True}))["targetId"]
        try:
            win = (await cdp.cmd("Browser.getWindowForTarget",
                                 {"targetId": tid}))["windowId"]
            await cdp.cmd("Browser.setWindowBounds",
                          {"windowId": win, "bounds": {"windowState": "maximized"}})
        except Exception as exc:  # noqa: BLE001 — maximizing is cosmetic
            logger.warning("private window maximize failed: %s", exc)
        try:
            sid = (await cdp.cmd("Target.attachToTarget",
                                 {"targetId": tid, "flatten": True}))["sessionId"]
            await cdp.cmd("Network.enable", {}, sid)
            await cdp.cmd("Network.setExtraHTTPHeaders",
                          {"headers": {"Accept-Language": PRIVATE_ACCEPT_LANGUAGE}}, sid)
            await cdp.cmd("Emulation.setLocaleOverride",
                          {"locale": PRIVATE_ACCEPT_LANGUAGE.split(",")[0]}, sid)
            await cdp.cmd("Page.navigate", {"url": url}, sid)
            # The overrides live as long as this session — let the redirects run.
            await asyncio.sleep(2)
        except Exception as exc:  # noqa: BLE001 — open it anyway, just without the language
            logger.warning("private window language setup failed: %s", exc)
            await cdp.cmd("Target.closeTarget", {"targetId": tid})
            tid = (await cdp.cmd("Target.createTarget",
                                 {"url": url, "browserContextId": ctx,
                                  "newWindow": True}))["targetId"]
        # Bring it to the FRONT — otherwise the stream keeps showing the old
        # window and the user sees nothing (Clara then opened it again and again).
        try:
            await cdp.cmd("Target.activateTarget", {"targetId": tid})
        except Exception as exc:  # noqa: BLE001
            logger.warning("private window activate failed: %s", exc)
        return ctx, tid, await _was_geladen(cdp, tid)

    try:
        context_id, target_id, geladen = await _with_cdp(_open, username, form)
    except Exception as exc:  # noqa: BLE001
        logger.warning("selkies open (private) failed: %s", exc)
        return {"error": "cdp_unreachable"}

    await _browser_nach_vorn(username, form)
    logger.info("BROWSER-OPEN privat: %s → %s (%s, ctx %s, Quelle %s)",
                username, _base_host(url), form, context_id[:12], body.source or "—")
    return {"status": "opened", "mode": "private", "form": form,
            "contextId": context_id, "targetId": target_id, **geladen}


class AnsehenBody(BaseModel):
    form: str = ""


@router.post("/selkies/ansehen")
async def selkies_ansehen(request: Request, body: AnsehenBody) -> dict:
    """What the user's browser shows right now: address, title and a description
    of a screenshot of the active tab.

    The agent cannot see the stream (its screen reader only gets the shell's
    text; the browser is a video there), so it opened pages blind and told the
    user they were there. This is its look at the user's real browser.
    """
    username = require_caller(request)
    from routers.actions import aktuelle_form
    from routers.marker_context import bild_beschreiben
    entry = await user_browser(username)
    form = body.form if body.form in ("mobile", "desktop") else (aktuelle_form(username) or "desktop")
    _int, _pub, cdp_base = _endpoints_for(entry, form)
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            tabs = [t for t in (await client.get(f"{cdp_base}/json/list")).json()
                    if t.get("type") == "page"]
    except Exception as exc:  # noqa: BLE001
        logger.warning("selkies ansehen: %s", exc)
        return {"error": "browser_unreachable"}
    if not tabs:
        return {"error": "no_tab"}
    tab = tabs[0]  # /json/list leads with the active tab
    from websockets.asyncio.client import connect
    try:
        async with connect(tab["webSocketDebuggerUrl"], max_size=None, open_timeout=5) as ws:
            await ws.send(json.dumps({"id": 1, "method": "Page.captureScreenshot",
                                      "params": {"format": "jpeg", "quality": 60}}))
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
                if msg.get("id") == 1:
                    break
        bild = (msg.get("result") or {}).get("data", "")
    except Exception as exc:  # noqa: BLE001
        logger.warning("selkies ansehen screenshot: %s", exc)
        bild = ""
    beschreibung = ""
    if bild:
        beschreibung = await bild_beschreiben(
            bild, tab.get("title") or "Browser",
            litellm_url=os.environ.get("LITELLM_BASE_URL", ""),
            litellm_key=os.environ.get("LITELLM_MASTER_KEY", ""))
    return {"form": form, "url": tab.get("url", ""), "title": tab.get("title", ""),
            "beschreibung": beschreibung or "(no description — screenshot or vision model unavailable)"}


class CloseCtxBody(BaseModel):
    contextId: str


@router.post("/selkies/close-private")
async def selkies_close_private(request: Request, body: CloseCtxBody) -> dict:
    """Discard a private session — afterwards it is forgotten (by design: when
    the window closes, not only after a timeout)."""
    user = get_current_user(request)
    from routers.admin_view import _with_cdp

    async def _dispose(cdp):
        await cdp.cmd("Target.disposeBrowserContext", {"browserContextId": body.contextId})

    try:
        await _with_cdp(_dispose, user.get("username", ""))
    except Exception as exc:  # noqa: BLE001
        logger.warning("dispose private context failed: %s", exc)
        return {"error": "dispose_failed"}
    logger.info("BROWSER-CLOSE privat: %s (ctx %s)",
                user.get("username", ""), body.contextId[:12])
    return {"status": "closed"}


@router.get("/health")
async def check_health(url: str, request: Request) -> dict:
    """Is an app URL reachable? **Admins only.**

    Security: this route accepts an **arbitrary** URL, fetches it server-side
    (`follow_redirects`, `verify=False`) and reports the status code back.
    Without authentication, anyone on the local network could use the API as a
    **scanner from its own network position** — including `127.0.0.1` and
    Docker-internal addresses that are unreachable from outside, e.g.:

        …/apps/health?url=http://<router-ip>/                  → 200
        …/apps/health?url=http://127.0.0.1:8090/…/system/health → 405

    That is a server-side request forgery (SSRF), hence the admin requirement.

    There is no production caller (only a test); it is kept as a diagnostic
    tool behind an identity check.

    TODO: validate the target against the **URLs of known manifests** instead
    of accepting arbitrary ones. That would remove the class of bug entirely
    rather than just fencing it in.
    """
    user = get_current_user(request)          # raises 401 without a valid identity
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Nur für Administratoren.")
    if not str(url).lower().startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Nur http:// oder https://")
    try:
        async with httpx.AsyncClient(timeout=5, verify=False) as client:
            resp = await client.head(url, follow_redirects=True)
            return {"reachable": resp.status_code < 500, "status": resp.status_code}
    except Exception:
        return {"reachable": False, "status": 0}


# ── DYNAMIC ROUTES (/{app_id} catch-all) ──

# ── Third-party services for Clara (Dienste hub) ───────────────────────────
# The hub's services (routers/hub.py, manifest hubService) are tiles that open in the
# user's own browser. Clara may list the ones THIS user sees and open one — managing
# them stays with a human admin (hub.py). Same visibility rule as the tiles; the
# caller comes from require_caller, the groups from Authentik (a tool call carries
# only the user name).

async def _dienste_fuer(username: str) -> list[dict]:
    from routers.teams_admin import ak_get_user_by_username
    u = await ak_get_user_by_username(username)
    if not u:
        return []
    groups = [g.get("name", "") for g in u.get("groups_obj") or []]
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT id, manifest FROM claraos_apps WHERE enabled = TRUE "
                                "AND manifest->>'hubService' = 'true' ORDER BY id")
    async with user_tx(username) as conn:
        ov = {r["app_id"]: r["enabled"] for r in await conn.fetch(
            "SELECT app_id, enabled FROM claraos_user_apps WHERE username = $1", username)}
    out = []
    for row in rows:
        m = json.loads(row["manifest"])
        if _sichtbar(m, ov.get(row["id"]), username, groups):
            out.append({"id": row["id"], "name": m.get("name"), "url": (m.get("config") or {}).get("url")})
    return out


@router.get("/dienste")
async def dienste(request: Request) -> dict:
    """The third-party services this user has as tiles (Dienste hub)."""
    return {"dienste": await _dienste_fuer(require_caller(request))}


class DienstOeffnen(BaseModel):
    id: str


@router.post("/dienste/oeffnen")
async def dienst_oeffnen(body: DienstOeffnen, request: Request) -> dict:
    """Open one of the user's services in their browser — logged in (session mode):
    that is what a service tile does, and the user asked for exactly this service."""
    username = require_caller(request)
    d = next((x for x in await _dienste_fuer(username) if x["id"] == body.id), None)
    if not d or not d.get("url"):
        raise HTTPException(404, "Diesen Dienst hast du nicht.")
    return await selkies_open(request, OpenUrlBody(url=d["url"], mode="session", source="dienste"))


@router.get("/{app_id}")
async def get_app(app_id: str, request: Request) -> dict:
    """The raw manifest of an app — **admins only**.

    Security: without an identity check, this route would return the full
    manifest to unauthenticated callers while `GET /api/claraos/apps` returns
    401. The manifest carries `config.url`, `authMethod`, `logoutPath` and the
    structure of the credential fields — together the **complete map of
    services** (paperless., immich. …). If the API port is
    published on the network, that is a ready-made reconnaissance list. No
    secrets, but still an information leak.

    Why **admin** and not just "authenticated": the only caller is the App
    Center, which does read-modify-write — the `PUT` next to it requires admin
    anyway. Whoever may read here may also write; anything else would be an
    inconsistent permission split.

    Why the manifest stays **raw** (no `_rewrite_app_for_tenant` /
    `_rewrite_user_scoped_url` as in `list_apps`): precisely because of that
    read-modify-write. If the personalised version came out here, the admin
    would write the rewritten URL back into the stored manifest — breaking it
    for **everyone**.
    """
    user = get_current_user(request)          # raises 401 without a valid identity
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Nur für Administratoren.")
    await _ensure_seeded()
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT manifest FROM claraos_apps WHERE id = $1 AND enabled = TRUE", app_id
        )
    if row:
        return json.loads(row["manifest"])
    return {"error": "not_found"}


@router.put("/{app_id}")
async def update_app(app_id: str, request: Request) -> dict:
    """Update an app manifest (admin only)."""
    user = get_current_user(request)
    if user["role"] != "admin":
        return {"error": "forbidden"}
    body = await request.json()
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            UPDATE claraos_apps SET manifest = $1, updated_at = NOW()
            WHERE id = $2
        """, json.dumps(body), app_id)
    return {"status": "updated"}


@router.post("/{app_id}/toggle")
async def toggle_app(app_id: str, request: Request) -> dict:
    """Enable/disable an app."""
    user = get_current_user(request)
    if user["role"] != "admin":
        return {"error": "forbidden"}
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            UPDATE claraos_apps SET enabled = NOT enabled, updated_at = NOW()
            WHERE id = $1
        """, app_id)
    return {"status": "toggled"}

