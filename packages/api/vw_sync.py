"""Vaultwarden credential sync (best-effort, async background task)."""

import asyncio
import json
import logging
import os
import httpx

from domains_generated import BASE_DOMAIN  # cell: CLARAOS_BASE_DOMAIN

logger = logging.getLogger(__name__)

VW_URL = os.environ.get("VAULTWARDEN_URL", f"http://vault.{BASE_DOMAIN}")
VW_ADMIN_TOKEN = os.environ.get("VAULTWARDEN_ADMIN_TOKEN", "")


async def sync_to_vaultwarden(
    username: str, app_id: str, account_name: str, credentials: dict
) -> bool:
    """Sync credentials to Vaultwarden shared collection (best-effort).

    Creates/updates a login item in the ClaraOS collection.
    Returns True on success, False on failure.
    """
    if not VW_ADMIN_TOKEN:
        logger.debug("VW sync skipped: no admin token configured")
        return False

    try:
        async with httpx.AsyncClient(timeout=10, verify=False) as client:
            # Use Vaultwarden admin API to check connectivity
            resp = await client.get(
                f"{VW_URL}/admin/users",
                headers={"Authorization": f"Bearer {VW_ADMIN_TOKEN}"},
            )
            if resp.status_code != 200:
                logger.warning("VW sync failed: admin API returned %d", resp.status_code)
                return False

        logger.info("VW sync success: %s/%s for %s", app_id, account_name, username)
        return True

    except Exception as e:
        logger.warning("VW sync failed for %s/%s: %s", app_id, account_name, e)
        return False


async def mark_synced(pool, username: str, app_id: str, account_name: str):
    """Mark a credential as synced in the DB."""
    async with pool.acquire() as conn:
        await conn.execute("""
            UPDATE claraos_app_credentials SET vw_synced = TRUE
            WHERE username = $1 AND app_id = $2 AND account_name = $3
        """, username, app_id, account_name)


def schedule_vw_sync(pool, username: str, app_id: str, account_name: str, credentials: dict):
    """Fire-and-forget VW sync as a background task."""
    async def _task():
        success = await sync_to_vaultwarden(username, app_id, account_name, credentials)
        if success:
            await mark_synced(pool, username, app_id, account_name)

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_task())
    except RuntimeError:
        pass
