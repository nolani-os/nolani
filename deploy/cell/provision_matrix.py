#!/usr/bin/env python3
"""Set up the cell's Matrix (Teams) — idempotent. Runs INSIDE the claraos-api container.

    docker compose exec -T -e SYNAPSE_REGISTRATION_SECRET -e ZELLE_DOMAIN claraos-api \
        python3 - alice zelle-test … < provision_matrix.py

1. `clara.bot` as Synapse admin (registered via shared secret if not present yet);
   credentials encrypted in claraos_app_credentials (app_id=matrix) — used by
   teams_admin._get_synapse_admin_token to log in.
2. Per user a Synapse account WITHOUT a password (admin API v2). Login happens only via
   an admin-minted token (/auth-proxy/element) — without an account the mint fails.
   Localpart = Authentik attribute `matrix_localpart` or the username (like teams_admin).
The shared secret enters the container only for this call. Never printed.
"""
import asyncio
import hashlib
import hmac
import os
import secrets
import sys

sys.path.insert(0, "/app")
import httpx  # noqa: E402

from database import get_pool  # noqa: E402
from encryption import decrypt_credentials, encrypt_credentials  # noqa: E402

SYN = os.environ.get("SYNAPSE_INTERNAL_URL", "http://synapse:8008").rstrip("/")
DOM = os.environ["ZELLE_DOMAIN"]
SECRET = os.environ["SYNAPSE_REGISTRATION_SECRET"].encode()


async def bot_creds() -> dict | None:
    pool = await get_pool()
    async with pool.acquire() as c:
        row = await c.fetchrow("SELECT credentials FROM claraos_app_credentials "
                               "WHERE app_id='matrix' AND username='clara.bot'")
    return decrypt_credentials(bytes(row["credentials"])) if row else None


async def store_bot(pw: str) -> None:
    blob = encrypt_credentials({"username": "clara.bot", "password": pw})
    pool = await get_pool()
    async with pool.acquire() as c:
        await c.execute("""INSERT INTO claraos_app_credentials (username, app_id, account_name, credentials, is_active)
            VALUES ('clara.bot','matrix','Default',$1,TRUE) ON CONFLICT (username, app_id, account_name)
            DO UPDATE SET credentials=EXCLUDED.credentials, is_active=TRUE, updated_at=NOW()""", blob)


async def register_bot(c: httpx.AsyncClient) -> None:
    nonce = (await c.get(f"{SYN}/_synapse/admin/v1/register")).json()["nonce"]
    pw = secrets.token_urlsafe(24)
    # Synapse: HMAC-SHA1 over nonce\0user\0password\0admin (no trailing \0)
    mac = hmac.new(SECRET, b"\x00".join(x.encode() for x in (nonce, "clara.bot", pw, "admin")),
                   hashlib.sha1).hexdigest()
    r = await c.post(f"{SYN}/_synapse/admin/v1/register", json={
        "nonce": nonce, "username": "clara.bot", "password": pw, "admin": True, "mac": mac})
    if r.status_code != 200:
        raise RuntimeError(f"clara.bot nicht registriert: HTTP {r.status_code} {r.text[:120]}")
    await store_bot(pw)
    print("  clara.bot: Synapse-Admin angelegt")


async def bot_token(c: httpx.AsyncClient) -> str:
    cr = await bot_creds()
    r = await c.post(f"{SYN}/_matrix/client/v3/login", json={
        "type": "m.login.password", "identifier": {"type": "m.id.user", "user": cr["username"]},
        "password": cr["password"], "device_id": "CLARAOS_ADMIN"})
    r.raise_for_status()
    return r.json()["access_token"]


async def localpart(c: httpx.AsyncClient, user: str) -> str:
    ak = os.environ.get("AUTHENTIK_URL", "http://authentik:9000").rstrip("/")
    tok = os.environ.get("AUTHENTIK_API_TOKEN", "")
    r = await c.get(f"{ak}/api/v3/core/users/", params={"username": user},
                    headers={"Authorization": f"Bearer {tok}"})
    hits = [u for u in r.json().get("results", []) if u.get("username") == user] if r.status_code == 200 else []
    return (hits[0].get("attributes") or {}).get("matrix_localpart") or user if hits else user


async def main(users: list[str]) -> None:
    async with httpx.AsyncClient(timeout=30) as c:
        if not await bot_creds():
            await register_bot(c)
        else:
            print("  clara.bot: vorhanden")
        h = {"Authorization": f"Bearer {await bot_token(c)}"}
        for u in users:
            mxid = f"@{await localpart(c, u)}:{DOM}"
            r = await c.get(f"{SYN}/_synapse/admin/v2/users/{mxid}", headers=h)
            if r.status_code == 200:
                print(f"  {u}: Matrix-Konto {mxid} vorhanden")
                continue
            r = await c.put(f"{SYN}/_synapse/admin/v2/users/{mxid}", headers=h,
                            json={"displayname": u, "admin": False})
            if r.status_code not in (200, 201):
                raise RuntimeError(f"{u}: Matrix-Konto nicht angelegt (HTTP {r.status_code} {r.text[:120]})")
            print(f"  {u}: Matrix-Konto {mxid} angelegt")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
