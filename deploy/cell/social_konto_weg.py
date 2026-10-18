#!/usr/bin/env python3
"""Remove a user's PeerTube account (social cell) — runs in the claraos-api container.

    docker compose exec -T -e PEERTUBE_ROOT_PASSWORD -e VIDEO_DOMAIN claraos-api \
        python3 - <username> < social_konto_weg.py

Mastodon accounts are removed with `tootctl accounts delete` (run_tests.sh).
Prints no secrets.
"""
import os
import re
import sys

import httpx

name = sys.argv[1]
H = {"Host": os.environ["VIDEO_DOMAIN"], "X-Forwarded-Proto": "https"}
with httpx.Client(base_url="http://peertube:9000", headers=H, timeout=60) as c:
    cl = c.get("/api/v1/oauth-clients/local").json()
    t = c.post("/api/v1/users/token", data={
        "client_id": cl["client_id"], "client_secret": cl["client_secret"], "grant_type": "password",
        "response_type": "code", "username": "root", "password": os.environ["PEERTUBE_ROOT_PASSWORD"]})
    h = {"Authorization": f"Bearer {t.json()['access_token']}"}
    users = c.get("/api/v1/users", headers=h, params={"search": name, "count": 50}).json().get("data", [])
    # PeerTube allows [a-z0-9._] only — the plugin turns everything else into "_"
    pt_name = re.sub(r"[^a-z0-9._]", "_", name.lower())
    # A taken (or deleted, still reserved) name gets -1, -2 …
    treffer = [u for u in users if re.fullmatch(re.escape(pt_name) + r"(-\d+)?", u["username"])
               and u["role"]["id"] != 0]
    for u in treffer:
        r = c.delete(f"/api/v1/users/{u['id']}", headers=h)
        print("PEERTUBE_GELOESCHT" if r.status_code == 204 else f"PEERTUBE_FEHLER {r.status_code}", name)
    if not treffer:
        print("PEERTUBE_KEIN_KONTO", name)
