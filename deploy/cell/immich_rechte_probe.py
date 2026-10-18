#!/usr/bin/env python3
"""Is Clara's Immich key really read-only? Runs in the claraos-api container:

    docker exec -i claraos-claraos-api-1 python3 - <username> <asset_id> < immich_rechte_probe.py

Loads the user's stored Clara key (never printed) and tries what it must NOT be able
to do. Prints only HTTP status codes: `LESEN <code> LOESCHEN <code> HOCHLADEN <code>`.
"""
import asyncio
import sys

import httpx

from database import user_tx
from encryption import decrypt_credentials

USER, ASSET = sys.argv[1], sys.argv[2]


async def main() -> None:
    async with user_tx(USER) as conn:
        row = await conn.fetchrow(
            "SELECT credentials FROM claraos_app_credentials WHERE username=$1 AND app_id='immich'", USER)
    key = decrypt_credentials(row["credentials"])["api_key"]
    h = {"x-api-key": key}
    async with httpx.AsyncClient(base_url="http://immich-server:2283/api", headers=h, timeout=30) as c:
        lesen = (await c.get(f"/assets/{ASSET}")).status_code
        loeschen = (await c.request("DELETE", "/assets", json={"ids": [ASSET], "force": False})).status_code
        hoch = (await c.post("/assets", files={"assetData": ("x.jpg", b"\xff\xd8\xff\xd9", "image/jpeg")},
                             data={"fileCreatedAt": "2020-01-01T00:00:00.000Z",
                                   "fileModifiedAt": "2020-01-01T00:00:00.000Z"})).status_code
    print(f"LESEN {lesen} LOESCHEN {loeschen} HOCHLADEN {hoch}")


asyncio.run(main())
