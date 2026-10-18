"""System health, info, and live-stats endpoints."""

from betriebsprofil import heim_default
import os
import time
from typing import Optional

from fastapi import APIRouter, Request

from auth import get_current_user

router = APIRouter(prefix="/api/claraos/system", tags=["system"])

# psutil is an optional dependency — fall back to placeholder values if missing
try:
    import psutil  # type: ignore
    _PSUTIL_AVAILABLE = True
except ImportError:
    psutil = None  # type: ignore
    _PSUTIL_AVAILABLE = False


@router.get("/health")
async def health() -> dict:
    """Health check endpoint."""
    return {"status": "ok", "service": "claraos-api", "version": "0.1.0"}


@router.get("/readyz")
async def readyz() -> dict:
    """Readiness check: verifies real dependencies instead of mere liveness.

    - Postgres pool (SELECT 1) — without the DB the API cannot do any work.
    - Object storage only if S3 is configured (soft dependency: 'degraded'
      instead of 503 — core features currently work without S3).
    """
    import asyncio

    from fastapi import HTTPException
    from database import get_pool

    try:
        pool = await get_pool()
        await asyncio.wait_for(pool.fetchval("SELECT 1"), timeout=5)
    except Exception:
        raise HTTPException(status_code=503, detail="db not ready")

    result: dict = {"status": "ready", "db": "ok"}
    if os.environ.get("S3_ENDPOINT"):
        import storage
        s3_ok = await asyncio.get_event_loop().run_in_executor(None, storage.health)
        result["s3"] = "ok" if s3_ok else "unreachable"
        if not s3_ok:
            result["status"] = "degraded"
    return result


_AUTHENTIK_URL = heim_default("AUTHENTIK_URL", key="AUTHENTIK_URL@system")
_AUTHENTIK_TOKEN = os.environ.get("AUTHENTIK_API_TOKEN", "")


async def _authentik_user_count() -> int:
    """Query Authentik for the count of active users.
    Returns -1 on failure (e.g. token missing or upstream unreachable)."""
    if not _AUTHENTIK_TOKEN:
        return -1
    try:
        import httpx
        async with httpx.AsyncClient(timeout=5.0) as c:
            r = await c.get(
                f"{_AUTHENTIK_URL}/api/v3/core/users/?is_active=true&page_size=1",
                headers={"Authorization": f"Bearer {_AUTHENTIK_TOKEN}"},
            )
        if r.status_code != 200:
            return -1
        return int(r.json().get("pagination", {}).get("count", -1))
    except Exception:  # noqa: BLE001
        return -1


@router.get("/info")
async def system_info(request: Request) -> dict:
    """System information (admin only)."""
    user = get_current_user(request)
    if user["role"] != "admin":
        return {"error": "forbidden"}
    user_count = await _authentik_user_count()
    return {
        "version": "0.1.0",
        "service": "claraos-api",
        "user_count": user_count,
    }


# ---- Live stats (consumed by SystemStatsWidget + Quick-Settings panel) -------

# 1-second cache to keep request rate down even if multiple widgets poll
_STATS_CACHE: Optional[dict] = None
_STATS_CACHE_TS: float = 0.0
_STATS_TTL_S: float = 1.0

# Track last network counters for delta-based throughput
_LAST_NET: Optional[dict] = None


def _read_stats() -> dict:
    """Read current CPU/RAM/Disk/Net stats. Returns dict with None values when psutil missing."""
    global _LAST_NET

    if not _PSUTIL_AVAILABLE:
        return {
            "cpu": None,
            "ram": None,
            "disk": None,
            "net": None,
            "uptime": None,
            "psutil": False,
        }

    cpu = psutil.cpu_percent(interval=None)  # non-blocking; uses last call as baseline
    vm = psutil.virtual_memory()
    du = psutil.disk_usage("/")

    # Network throughput — derive bytes/s from delta since last call
    counters = psutil.net_io_counters()
    now = time.time()
    net = None
    if _LAST_NET is not None:
        elapsed = max(now - _LAST_NET["t"], 0.001)
        net = {
            "rx": int((counters.bytes_recv - _LAST_NET["rx"]) / elapsed),
            "tx": int((counters.bytes_sent - _LAST_NET["tx"]) / elapsed),
        }
    _LAST_NET = {"t": now, "rx": counters.bytes_recv, "tx": counters.bytes_sent}

    return {
        "cpu": round(cpu, 1),
        "ram": round(vm.percent, 1),
        "disk": round(du.percent, 1),
        "net": net,
        "uptime": int(time.time() - psutil.boot_time()),
        "psutil": True,
    }


@router.get("/stats")
async def system_stats(request: Request) -> dict:
    """Live system stats — CPU, RAM, disk, network throughput.

    Cached for 1 s to keep concurrent widget polls cheap. Authenticated users
    only (any role); we don't gate this since the data is system-wide and
    non-sensitive.
    """
    # Touch user lookup so an unauthenticated request fails like other endpoints
    get_current_user(request)

    global _STATS_CACHE, _STATS_CACHE_TS
    now = time.time()
    if _STATS_CACHE is None or now - _STATS_CACHE_TS > _STATS_TTL_S:
        _STATS_CACHE = _read_stats()
        _STATS_CACHE_TS = now
    return _STATS_CACHE


# ── Multi-target monitor (desktop widget) ────────────────────────────────────
#
# The monitoring targets (hosts, VMs, devices) belong to the installation: they
# come from the optional module services/monitor_heim.py (deployment-specific).
# Without it there are no targets and the widget shows a hint.

try:
    from services import monitor_heim as _monitor_heim
except ImportError:
    _monitor_heim = None


@router.get("/targets")
async def monitor_targets(request: Request) -> dict:
    """Selectable monitoring targets for the widget (settings list)."""
    get_current_user(request)
    if _monitor_heim is None:
        return {"pve_configured": False, "targets": []}
    return await _monitor_heim.targets()


@router.get("/target-stats")
async def monitor_target_stats(request: Request, ids: str = "") -> dict:
    """Live values for the selected targets (widget poll)."""
    get_current_user(request)
    if _monitor_heim is None:
        return {"pve_configured": False, "targets": []}
    return await _monitor_heim.target_stats(ids)
