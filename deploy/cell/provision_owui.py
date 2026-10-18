#!/usr/bin/env python3
"""Open WebUI account per ClaraOS user — idempotent. Runs INSIDE the claraos-api container.

    docker compose exec -T claraos-api python3 - alice zelle-test … < provision_owui.py

Warning: why this is needed: without an Open WebUI account the API answers chat creation
with 503 (chat_v2._get_webui_token, strict) — and the UI then does NOT send the question
at all, without any message. An API-only test still passes, because /completions falls
back to the service identity. Only checking in the browser reveals it.

Open WebUI matches users by email (chat_v2._webui_user_id) — hence exactly the email from
Authentik. The password is random and stored nowhere: nobody logs in directly, only via
the ClaraOS API's short-lived token.
"""
import asyncio
import os
import secrets
import sys

import httpx

OWUI = os.environ.get("OPENWEBUI_URL", "http://open-webui:8080").rstrip("/")
KEY = os.environ["OPENWEBUI_API_KEY"]
AK = os.environ.get("AUTHENTIK_URL", "http://authentik:9000").rstrip("/")
AK_TOKEN = os.environ.get("AUTHENTIK_API_TOKEN", "")


async def main(users: list[str]) -> None:
    h = {"Authorization": f"Bearer {KEY}"}
    async with httpx.AsyncClient(timeout=30) as c:
        vorhanden = {(u.get("email") or "").lower()
                     for u in (await c.get(f"{OWUI}/api/v1/users/", headers=h)).json().get("users", [])}
        for user in users:
            r = await c.get(f"{AK}/api/v3/core/users/", params={"username": user},
                            headers={"Authorization": f"Bearer {AK_TOKEN}"})
            treffer = [u for u in r.json().get("results", []) if u.get("username") == user]
            if not treffer or not treffer[0].get("email"):
                print(f"  ✗ {user}: kein Authentik-Konto mit E-Mail")
                continue
            mail = treffer[0]["email"].lower()
            if mail in vorhanden:
                print(f"  {user}: Open-WebUI-Konto vorhanden")
                continue
            r = await c.post(f"{OWUI}/api/v1/auths/add", headers=h, json={
                "name": treffer[0].get("name") or user, "email": mail,
                "password": secrets.token_urlsafe(24), "role": "user"})
            if r.status_code != 200:
                print(f"  ✗ {user}: Open-WebUI-Konto nicht angelegt (HTTP {r.status_code})")
                continue
            print(f"  {user}: Open-WebUI-Konto angelegt")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
