#!/usr/bin/env python3
"""Remove a user's Immich account for good — runs in the claraos-api container.

    docker compose exec -T -e IMMICH_API_KEY claraos-api python3 - <username> < medien_konto_weg.py

Matched by storage label (= Authentik username, set from `preferred_username`), not by
e-mail: the test account's address is made up. `force` deletes at once, including all
photos — without it Immich keeps the account for days. Prints no secrets.
"""
import os
import sys

import httpx

name = sys.argv[1]
h = {"x-api-key": os.environ["IMMICH_API_KEY"]}
with httpx.Client(base_url="http://immich-server:2283/api", headers=h, timeout=30) as c:
    nutzer = c.get("/admin/users", params={"withDeleted": "true"}).json()
    treffer = [u for u in nutzer if u.get("storageLabel") == name and not u.get("isAdmin")]
    for u in treffer:
        r = c.request("DELETE", f"/admin/users/{u['id']}", json={"force": True})
        print("IMMICH_GELOESCHT" if r.status_code in (200, 204) else f"IMMICH_FEHLER {r.status_code}", name)
    if not treffer:
        print("IMMICH_KEIN_KONTO", name)
