#!/usr/bin/env python3
"""Set up Nextcloud access per ClaraOS user — idempotent.

Runs INSIDE the claraos-api container
(which has httpx, asyncpg and encryption.py):

    docker compose exec -T -e NEXTCLOUD_ADMIN_USER -e NEXTCLOUD_ADMIN_PASSWORD \
      claraos-api python3 - alice clara.bot:admin < provision_nc.py

Per user:
  1. Create the Nextcloud account (if missing) with a random password nobody knows
  2. Use that password to have ONE app password issued (getapppassword)
  3. Store the app password encrypted in claraos_app_credentials (app_id=nextcloud, active)

Important: why per user instead of a service account: without their own credentials
   files.py falls back to NEXTCLOUD_SERVICE_USER — in a cell shared by unrelated users
   that would mean everyone sees the same files. This script makes the service account
   unnecessary.
Important: the admin credentials enter the container only for this call and do not stay
   in the API's environment. No password is ever printed.
Suffix `:admin` → the user joins the Nextcloud group admin (only for clara.bot, which
Teams needs for groups/group folders).
"""
import asyncio
import os
import secrets
import sys

sys.path.insert(0, "/app")
import httpx  # noqa: E402

from database import get_pool  # noqa: E402
from encryption import encrypt_credentials  # noqa: E402

NC = os.environ.get("NEXTCLOUD_INTERNAL_URL", "http://nextcloud").rstrip("/")
ADMIN = (os.environ["NEXTCLOUD_ADMIN_USER"], os.environ["NEXTCLOUD_ADMIN_PASSWORD"])
OCS = {"OCS-APIRequest": "true", "Accept": "application/json"}


async def ensure_user(c: httpx.AsyncClient, user: str, admin: bool) -> str | None:
    """Create the user and return their random password. If the user already exists,
    their password is reset so that an app password can still be issued."""
    pw = secrets.token_urlsafe(24)
    r = await c.get(f"{NC}/ocs/v1.php/cloud/users/{user}", auth=ADMIN, headers=OCS)
    exists = r.status_code == 200 and r.json()["ocs"]["meta"]["statuscode"] == 100
    if exists:
        r = await c.put(f"{NC}/ocs/v1.php/cloud/users/{user}", auth=ADMIN, headers=OCS,
                        data={"key": "password", "value": pw})
    else:
        data = {"userid": user, "password": pw}
        if admin:
            data["groups[]"] = "admin"
        r = await c.post(f"{NC}/ocs/v1.php/cloud/users", auth=ADMIN, headers=OCS, data=data)
    code = r.json()["ocs"]["meta"]["statuscode"] if r.status_code == 200 else r.status_code
    if code != 100:
        raise RuntimeError(f"{user}: Nutzer anlegen/aktualisieren fehlgeschlagen ({code})")
    if exists and admin:
        await c.post(f"{NC}/ocs/v1.php/cloud/users/{user}/groups", auth=ADMIN, headers=OCS,
                     data={"groupid": "admin"})
    return pw


async def app_password(c: httpx.AsyncClient, user: str, pw: str) -> str:
    r = await c.get(f"{NC}/ocs/v2.php/core/getapppassword", auth=(user, pw), headers=OCS)
    if r.status_code != 200:
        raise RuntimeError(f"{user}: App-Passwort nicht erhalten (HTTP {r.status_code})")
    return r.json()["ocs"]["data"]["apppassword"]


async def store(user: str, apppw: str) -> None:
    blob = encrypt_credentials({"username": user, "password": apppw})
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO claraos_app_credentials (username, app_id, account_name, credentials, is_active)
               VALUES ($1, 'nextcloud', 'Default', $2, TRUE)
               ON CONFLICT (username, app_id, account_name)
               DO UPDATE SET credentials = EXCLUDED.credentials, is_active = TRUE, updated_at = NOW()""",
            user, blob)


async def main(args: list[str]) -> None:
    async with httpx.AsyncClient(timeout=30) as c:
        for arg in args:
            user, _, flag = arg.partition(":")
            pw = await ensure_user(c, user, flag == "admin")
            apppw = await app_password(c, user, pw)
            await store(user, apppw)
            print(f"  {user}: Nextcloud-Zugang eingerichtet{' (admin)' if flag == 'admin' else ''}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    asyncio.run(main(sys.argv[1:]))
