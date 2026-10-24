#!/usr/bin/env python3
"""Set up the social cell's PeerTube — idempotent. Runs in the claraos-api container.

    docker compose exec -T -e PEERTUBE_ROOT_PASSWORD -e PEERTUBE_OIDC_SECRET \
        -e PEERTUBE_VIDEO_QUOTA_GB -e ZELLE_DOMAIN -e VIDEO_DOMAIN \
        claraos-api python3 - < provision_peertube.py

1. Log in as root (local OAuth client; PeerTube only hands it out for its own host name).
2. OIDC plugin: login via the cell's Authentik, user name = Authentik user name.
3. Instance: no self-signup, followers only after approval, no automatic following
   (federation = allowlist), per-user video quota, modest transcoding.
Prints only short status lines — never passwords or tokens.
"""
import os
import sys
import time

import httpx

BASE = "http://peertube:9000"
DOM = os.environ["ZELLE_DOMAIN"]
VIDEO = os.environ["VIDEO_DOMAIN"]
HOST = {"Host": VIDEO, "X-Forwarded-Proto": "https"}
QUOTA = int(os.environ.get("PEERTUBE_VIDEO_QUOTA_GB") or 2) * 1024 ** 3
PLUGIN = "peertube-plugin-auth-openid-connect"
PRODUCT = os.environ.get("CLARAOS_PRODUCT_NAME") or "NolaniOS"  # visible name only

with httpx.Client(base_url=BASE, headers=HOST, timeout=60) as c:
    cl = c.get("/api/v1/oauth-clients/local")
    if cl.status_code != 200:
        sys.exit(f"  ✗ PeerTube: kein lokaler OAuth-Client (HTTP {cl.status_code})")
    cl = cl.json()
    t = c.post("/api/v1/users/token", data={
        "client_id": cl["client_id"], "client_secret": cl["client_secret"],
        "grant_type": "password", "response_type": "code",
        "username": "root", "password": os.environ["PEERTUBE_ROOT_PASSWORD"]})
    if t.status_code != 200:
        sys.exit(f"  ✗ PeerTube: root-Anmeldung abgelehnt (HTTP {t.status_code})")
    h = {"Authorization": f"Bearer {t.json()['access_token']}"}

    # The plugin registers its settings shortly after installation.
    for _ in range(12):
        if c.get(f"/api/v1/plugins/{PLUGIN}", headers=h).status_code == 200:
            break
        time.sleep(5)
    r = c.put(f"/api/v1/plugins/{PLUGIN}/settings", headers=h, json={"settings": {
        "auth-display-name": f"Mit {PRODUCT} anmelden",
        "discover-url": f"https://auth.{DOM}/application/o/peertube/.well-known/openid-configuration",
        "client-id": "peertube",
        "client-secret": os.environ["PEERTUBE_OIDC_SECRET"],
        "scope": "openid email profile",
        "username-property": "preferred_username",
        "mail-property": "email",
        "display-name-property": "name",
        "signature-algorithm": "RS256",
    }})
    print(f"  PeerTube: OIDC-Plugin {'eingerichtet' if r.status_code in (200, 204) else f'NICHT eingerichtet (HTTP {r.status_code})'}")

    cfg = c.get("/api/v1/config/custom", headers=h).json()
    cfg["instance"]["name"] = f"{PRODUCT} Videos"
    cfg["signup"]["enabled"] = False
    cfg["user"]["videoQuota"] = QUOTA
    cfg["user"]["videoQuotaDaily"] = -1
    cfg["followers"]["instance"]["enabled"] = True
    cfg["followers"]["instance"]["manualApproval"] = True
    cfg["followings"]["instance"]["autoFollowBack"]["enabled"] = False
    cfg["followings"]["instance"]["autoFollowIndex"]["enabled"] = False
    cfg["contactForm"]["enabled"] = False
    # Users have no PeerTube password — go straight to the single sign-on login.
    # (root still logs in locally via /login?externalRedirect=false)
    cfg["client"]["menu"]["login"]["redirectOnSingleExternalAuth"] = True
    tc = cfg["transcoding"]
    tc["threads"] = 1
    tc["concurrency"] = 1
    for res in list(tc["resolutions"]):
        tc["resolutions"][res] = res in ("480p", "720p")
    r = c.put("/api/v1/config/custom", headers=h, json=cfg)
    if r.status_code != 200:
        sys.exit(f"  ✗ PeerTube: Einstellungen abgelehnt (HTTP {r.status_code}) {r.text[:200]}")
    print(f"  PeerTube: Registrierung aus, Folgen nur nach Freigabe, "
          f"{QUOTA // 1024 ** 3} GB je Nutzer, Umwandlung 480p/720p")
