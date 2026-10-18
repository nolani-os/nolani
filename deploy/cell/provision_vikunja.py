#!/usr/bin/env python3
"""Set up Planner access (Vikunja) per ClaraOS user — idempotent.

Runs INSIDE the claraos-api container:
    docker compose exec -T -e ZELLE_DOMAIN claraos-api python3 - alice … < provision_vikunja.py

Per user: register a Vikunja account (random password nobody knows) → log in →
API token with all permissions, expiring 2099 → stored encrypted in
claraos_app_credentials (app_id=vikunja, key api_token), as the Planner BFF reads it.
Done by hand this would mean login + token in the Vikunja UI;
for demo users it has to be automatic.
Users that already have active credentials are left untouched.
"""
import asyncio
import os
import secrets
import sys

sys.path.insert(0, "/app")
import httpx  # noqa: E402

from database import get_pool  # noqa: E402
from encryption import encrypt_credentials  # noqa: E402

VK = os.environ.get("VIKUNJA_INTERNAL_URL", "http://vikunja:3456").rstrip("/") + "/api/v1"
DOM = os.environ["ZELLE_DOMAIN"]


async def vorhanden(user: str) -> bool:
    pool = await get_pool()
    async with pool.acquire() as conn:
        return bool(await conn.fetchval(
            "SELECT 1 FROM claraos_app_credentials WHERE username=$1 AND app_id='vikunja' AND is_active",
            user))


async def einrichten(c: httpx.AsyncClient, user: str) -> None:
    pw = secrets.token_urlsafe(24)
    r = await c.post(f"{VK}/register", json={"username": user, "email": f"{user}@{DOM}", "password": pw})
    if r.status_code not in (200, 201):
        raise RuntimeError(f"{user}: Registrierung fehlgeschlagen (HTTP {r.status_code}: {r.text[:120]})")
    r = await c.post(f"{VK}/login", json={"username": user, "password": pw})
    r.raise_for_status()
    h = {"Authorization": f"Bearer {r.json()['token']}"}
    routes = (await c.get(f"{VK}/routes", headers=h)).json()
    rechte = {gruppe: list(r2.keys()) for gruppe, r2 in routes.items()}
    r = await c.put(f"{VK}/tokens", headers=h, json={
        "title": "ClaraOS", "expires_at": "2099-12-31T23:59:59Z", "permissions": rechte})
    if r.status_code not in (200, 201):
        raise RuntimeError(f"{user}: Token nicht erzeugt (HTTP {r.status_code}: {r.text[:120]})")
    token = r.json()["token"]
    blob = encrypt_credentials({"api_token": token})
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO claraos_app_credentials (username, app_id, account_name, credentials, is_active)
               VALUES ($1, 'vikunja', 'Default', $2, TRUE)
               ON CONFLICT (username, app_id, account_name)
               DO UPDATE SET credentials = EXCLUDED.credentials, is_active = TRUE, updated_at = NOW()""",
            user, blob)


async def main(users: list[str]) -> None:
    async with httpx.AsyncClient(timeout=30) as c:
        for u in users:
            if await vorhanden(u):
                print(f"  {u}: Planner-Zugang vorhanden")
                continue
            await einrichten(c, u)
            print(f"  {u}: Planner-Zugang eingerichtet")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    asyncio.run(main(sys.argv[1:]))
