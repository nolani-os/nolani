"""ClaraOS API – FastAPI backend for the browser-based desktop environment."""

from betriebsprofil import heim_default  # external cell: no silent home fallback
import logging
import os
from contextlib import AsyncExitStack, asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

import betriebsprofil
from domains_generated import BASE_DOMAIN  # cell: CLARAOS_BASE_DOMAIN
from auth import get_current_user
from database import close_pool, get_pool
import importlib

from router_registry import ROUTERS

# Optional installation-specific startup and daemons (module `main_heim`). If the
# module is missing, the API starts without them.
try:
    import main_heim as _heim
except ImportError:
    _heim = None

logger = logging.getLogger(__name__)

AUTHENTIK_LOGOUT_URL = os.environ.get(
    "AUTHENTIK_LOGOUT_URL",
    f"https://auth.{BASE_DOMAIN}/if/flow/default-invalidation-flow/",
)

STATIC_DIR = os.environ.get("STATIC_DIR", "")

# An external cell refuses to start if its configuration points into the
# home network. A no-op at home.
betriebsprofil.assert_cell_config()

# Federation mode: claraos-api on a federation instance (e.g. a lab host)
# that does NOT carry the full app set of the primary instance. Skips the
# primary-specific background daemons (vault keep-alive/Vaultwarden,
# DBOS orchestrator, the installation's daemons) — clean instead of accidental
# degradation. The secret bootstrap is conditional anyway.
FEDERATION_MODE = os.environ.get("CLARAOS_FEDERATION_MODE", "").lower() in (
    "1", "true", "yes", "on",
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Startup/shutdown lifecycle."""
    # FIRST: the installation's secret bootstrap (main_heim.py) — it fills
    # os.environ before other startup hooks read it.
    if _heim is not None:
        _heim.bootstrap_secrets()

    # Clara-tools drop-in registry (H.2 / P3): reads /opt/claraos/clara-tools.d/
    # populated by the module-loader on every module install/uninstall.
    try:
        from services.clara_tools_registry import registry as _ct_registry
        _ct_summary = _ct_registry.reload()
        logger.warning(
            "[clara-tools] initial load: %d module(s), %d tool(s), %d ui-hook(s)",
            len(_ct_summary["modules"]), _ct_summary["tools_total"],
            _ct_summary["ui_hooks_total"],
        )
    except Exception as exc:
        logger.error("[clara-tools] initial load EXCEPTION: %s", exc, exc_info=True)

    # Tenancy bulk: tenant_id + FORCE RLS on all our own tables (idempotent,
    # advisory lock; also covers lazily created tables by the next start at the
    # latest — see migrations/028_tenancy_bulk.sql).
    async def _tenancy_with_retry() -> None:
        # The API can come up before the DB (k8s rollout) — a one-shot attempt
        # was not enough. Retry until it succeeds, then stop.
        import asyncio as _aio

        import tenancy as _tenancy
        from database import get_pool as _get_pool
        while True:
            try:
                _n = await _tenancy.ensure_all_rls(await _get_pool())
                logger.warning("[tenancy] RLS auf %d Tabellen sichergestellt", _n)
                return
            except Exception as exc:
                logger.warning("[tenancy] ensure_all_rls fehlgeschlagen, Retry in 20s: %s", exc)
                await _aio.sleep(20)

    import asyncio as _aio_lifespan
    _aio_lifespan.get_event_loop().create_task(_tenancy_with_retry())

    # Stop idle personal browser instances.
    # Without this, 2 containers per user permanently occupy ~450 MB. Only
    # `managed` instances are stopped — never the admin's reference instance (index 0).
    async def _browser_reaper():
        import asyncio as _aio_reaper
        from routers.apps import reap_idle_browsers
        while True:
            await _aio_reaper.sleep(300)
            try:
                n = await reap_idle_browsers(idle_minutes=30)
                if n:
                    logger.info("[browser-reaper] %d Instanz(en) schlafen gelegt", n)
            except Exception as exc:  # noqa: BLE001
                logger.warning("[browser-reaper] %s", exc)

    # A cell runs it only with its own browser controller (services/zellen_browser.py);
    # there it stops browsers nobody is connected to.
    from services import zellen_browser as _zellen_browser
    if not betriebsprofil.IS_CELL or _zellen_browser.ENABLED:
        _aio_lifespan.get_event_loop().create_task(_browser_reaper())

    # Routines: the scheduler runs only where an external brain is connected (a cell).
    from services import brain_turns as _brain_turns
    if betriebsprofil.IS_CELL and _brain_turns.enabled():
        from services import routinen as _routinen
        _aio_lifespan.get_event_loop().create_task(_routinen.loop())

    # Mail: bring snoozed messages back at their wake-up time.
    from routers.post import snooze_loop as _post_snooze_loop
    _aio_lifespan.get_event_loop().create_task(_post_snooze_loop())

    # Calendar reminders (VALARM) as ntfy push notifications.
    from routers.planner_kalender import reminder_loop as _planner_reminder_loop
    _aio_lifespan.get_event_loop().create_task(_planner_reminder_loop())

    # Cross-instance event bus — per instance (LISTEN is local)
    try:
        from services import pg_bus
        pg_bus.start()
    except Exception as exc:
        logger.error("[pg-bus] Start fehlgeschlagen: %s", exc)

    # Per-instance infrastructure (deliberately NOT leader-gated): vault keep-alive
    # and DBOS orchestrator — EVERY instance needs their LISTEN/SSE fan-out and
    # bw session locally.
    if FEDERATION_MODE:
        logger.warning("[federation-mode] skipping vault/orchestrator daemons")
    else:
        # Vault keep-alive: warms the bw CLI session so /vault/* calls are <1s.
        try:
            from services.vw_client import start_keepalive
            start_keepalive()
        except Exception as exc:
            logging.getLogger(__name__).warning("vault keep-alive start failed: %s", exc)
        # DBOS agent-orchestration foundation (not in a cell: there is no
        # clara-agent there to submit tasks).
        if not betriebsprofil.IS_CELL:
            try:
                from services import orchestrator
                if orchestrator.configure():
                    orchestrator.register_smoke_workflows()
            except Exception as exc:
                logging.getLogger(__name__).warning("orchestrator init failed: %s", exc)

    # Singleton daemons run only on the LEADER (Postgres advisory lock,
    # services/leader.py) — otherwise with N instances they would run N times
    # (duplicate pushes/alerts/reindexing).
    def _start_singleton_daemons() -> None:
        # Background teams sync-daemon (polls every TEAMS_SYNC_INTERVAL s, default 300).
        try:
            from routers.teams_admin import start_sync_daemon
            start_sync_daemon()
        except Exception as exc:
            logging.getLogger(__name__).warning("teams sync-daemon start failed: %s", exc)
        # Cell: only the Teams sync. The other singleton daemons come from the
        # optional installation module (main_heim.py).
        if not FEDERATION_MODE and not betriebsprofil.IS_CELL and _heim is not None:
            _heim.start_singleton_daemons()

    try:
        from services import leader
        leader.start(_start_singleton_daemons)
    except Exception as exc:
        logger.error("[leader] Election-Start fehlgeschlagen: %s", exc)

    # MCP endpoint: its session manager lives as long as the app.
    _mcp_stack = AsyncExitStack()
    if betriebsprofil.MCP_ENABLED:
        from services import agent_mcp as _agent_mcp
        await _mcp_stack.enter_async_context(_agent_mcp.running())
    yield
    await _mcp_stack.aclose()
    # Drain: running chat answers finish (or are stored with a note) before
    # the container goes away. compose `stop_grace_period` must stay above this.
    try:
        from routers import chat_v2 as _chat_v2
        await _chat_v2.drain(float(os.environ.get("CLARAOS_DRAIN_S", "100")))
    except Exception as exc:  # noqa: BLE001 — shutdown must go on
        logger.error("chat drain failed: %s", exc)
    if not FEDERATION_MODE:
        try:
            from services import kb_indexer
            kb_indexer.stop_background()
        except Exception:
            pass
    if not FEDERATION_MODE:
        try:
            from services.vw_client import stop_keepalive
            stop_keepalive()
        except Exception:
            pass
        try:
            from services import orchestrator
            orchestrator.shutdown()
        except Exception:
            pass
        if _heim is not None:
            _heim.stop()
    await close_pool()


app = FastAPI(
    title="ClaraOS API",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS (for dev mode when frontend runs on different port)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def _fetch_user_groups(username: str) -> str:
    """Fetch groups for a user from Authentik (for impersonation context).

    Returns a pipe-separated string (Authentik header format).
    """
    import os
    import httpx
    authentik_url = heim_default("AUTHENTIK_URL", key="AUTHENTIK_URL@main")
    authentik_token = os.environ.get("AUTHENTIK_API_TOKEN", "")
    if not authentik_token:
        return ""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"{authentik_url}/api/v3/core/users/?username={username}",
                headers={"Authorization": f"Bearer {authentik_token}"},
            )
        data = resp.json()
        if data.get("results"):
            groups = [g["name"] for g in data["results"][0].get("groups_obj", [])]
            return "|".join(groups)
    except Exception as e:
        logger.error("Failed to fetch groups for %s: %s", username, e)
    return ""


# ── Security: administration paths are admin-only ──────────────────────────
#
# App tiles are enabled per user, but the HTTP paths behind them were NOT.
# Someone who did not see a tile could still call the endpoint — the
# permission was a UI matter, not an authorization boundary. Without this gate
# a non-admin user got the same agent tasks on `/orchestrator/tasks` as the
# admin, plus container hosts, module catalog and system targets.
#
# Why centrally here and not in each router: one place you can read, check
# and revert — instead of touching ten routers and having to remember it again
# for the next new router.
#
# Health/liveness paths are deliberately exempt: the shell and the watchers
# query them for every user, and they reveal nothing.
_ADMIN_ONLY_PREFIXES = (
    "/api/claraos/orchestrator",   # agent tasks incl. task texts
    "/api/claraos/containers",     # Docker control
    "/api/claraos/modules",        # module loader (installs/removes services)
    "/api/claraos/system",         # monitoring targets, host statistics
    # plus the installation's own admin-only routers (heim_werte)
    *betriebsprofil.heim_struktur("HEIM_ADMIN_PREFIXES", ()),
)
_ADMIN_GATE_EXEMPT_SUFFIXES = ("/health", "/readyz", "/livez", "/info", "/status")


@app.middleware("http")
async def admin_path_gate(request: Request, call_next):
    """Administration endpoints only for clara-admins (or service callers)."""
    path = request.url.path
    if path.startswith(_ADMIN_ONLY_PREFIXES) and not path.endswith(_ADMIN_GATE_EXEMPT_SUFFIXES):
        # Pure machine callers may pass (watchers, MCP without a user context).
        # Important: but ONLY without a user header: as soon as a service acts
        # "on behalf of X" — Clara does that all the time — X's permissions apply,
        # not the service's. Otherwise the service token would be a master key
        # that bypasses every gate by attaching someone else's name.
        from auth import is_service_call  # local: avoids an import cycle at startup
        caller = request.headers.get("X-Authentik-Username", "").strip()
        if caller or not is_service_call(request):
            groups = request.headers.get("X-Authentik-Groups", "")
            if "clara-admins" not in [g.strip() for g in groups.split("|")]:
                logger.warning("ADMIN_GATE: %s fuer %s abgelehnt",
                               path, request.headers.get("X-Authentik-Username", "?"))
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Dieser Bereich ist der Verwaltung vorbehalten."},
                )
    return await call_next(request)


@app.middleware("http")
async def impersonation_middleware(request: Request, call_next):
    """Detect impersonation cookie and rewrite X-Authentik-Username + groups.

    Flow:
    1. Request arrives with cookie `claraos_impersonate=target|session_id`
       AND Authentik headers showing the real admin user
    2. Verify: original user is in clara-admins group
    3. Replace X-Authentik-Username header with target user
    4. Fetch and replace X-Authentik-Groups with target's groups (so role resolves correctly)
    5. Add X-Claraos-Impersonator with original admin username (for audit)
    6. Continue normally — downstream handlers see target_user as current user
    """
    cookie = request.cookies.get("claraos_impersonate")
    # The cookie is scoped to the common parent domain of both sibling hosts so
    # it reaches both the shell (where the user admin app starts) and the
    # admin-view host (where the impersonated session runs in an iframe).
    # Headers are rewritten ONLY on the admin-view host — on the shell the admin
    # must keep seeing their own data.
    #
    # The check is deliberately domain-agnostic (prefix instead of full hostname)
    # and therefore survives a domain change unchanged. The cookie's parent
    # scope does not — see routers/impersonate.py.
    host = request.headers.get("host", "").lower()
    is_admin_view = host.startswith("admin-view.")

    if cookie and "|" in cookie and is_admin_view:
        target_user, _session_id = cookie.split("|", 1)

        # Get original user from Authentik headers
        original_username = request.headers.get("X-Authentik-Username", "")
        original_groups = request.headers.get("X-Authentik-Groups", "")

        # Security: only admins may impersonate
        if "clara-admins" in original_groups and original_username:
            # Fetch target user's groups from Authentik so role/permissions resolve correctly
            target_groups = await _fetch_user_groups(target_user)

            # Rewrite headers via scope manipulation
            new_headers = []
            for name_bytes, value_bytes in request.scope["headers"]:
                name_lower = name_bytes.decode("latin-1").lower()
                if name_lower == "x-authentik-username":
                    new_headers.append((b"x-authentik-username", target_user.encode("latin-1")))
                elif name_lower == "x-authentik-groups":
                    new_headers.append((b"x-authentik-groups", target_groups.encode("latin-1")))
                elif name_lower == "x-claraos-impersonator":
                    continue  # drop any pre-existing header
                else:
                    new_headers.append((name_bytes, value_bytes))

            # Add impersonator header for audit / end_session
            new_headers.append((b"x-claraos-impersonator", original_username.encode("latin-1")))
            request.scope["headers"] = new_headers

            logger.info("IMPERSONATION: %s acting as %s (groups=%s) on %s",
                        original_username, target_user, target_groups, request.url.path)
        else:
            logger.warning("IMPERSONATION DENIED: user=%s groups=%s path=%s",
                           original_username, original_groups, request.url.path)

    return await call_next(request)

# Register routers — in registry order, and only those the active profile allows.
# A cell never imports home-only router modules (betriebsprofil.active_routers).
for _module, _attrs in betriebsprofil.active_routers(ROUTERS):
    _mod = importlib.import_module(f"routers.{_module}")
    for _attr in _attrs:
        app.include_router(getattr(_mod, _attr))

# In an external cell keep only allowlisted routers (allowlist in
# betriebsprofil.py). A no-op at home.
betriebsprofil.prune_routes(app)

# MCP endpoint for outside agents (`/mcp`, `/mcp/{toolset}`), only when switched on.
# Added after pruning and before the static catch-all mount.
if betriebsprofil.MCP_ENABLED:
    from services import agent_keys, agent_mcp
    app.router.routes.extend(agent_mcp.routes(agent_keys.KeyVerifier()))


@app.get("/api/claraos/me")
async def get_me(request: Request) -> dict:
    """Return current authenticated user info."""
    user = get_current_user(request)
    user["logout_url"] = AUTHENTIK_LOGOUT_URL
    # External cell: the shell hides home-only features when running in a cell.
    user["profil"] = betriebsprofil.PROFILE
    return user


# Serve frontend static files (production mode)
if STATIC_DIR and os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8090)
