#!/usr/bin/env python3
"""Set up a cell's Immich (photos) — idempotent. Runs in the claraos-api container.

    docker compose exec -T -e IMMICH_ADMIN_PASSWORD -e IMMICH_API_KEY -e IMMICH_OIDC_SECRET \
        -e IMMICH_DEFAULT_QUOTA_GB -e ZELLE_DOMAIN claraos-api python3 - < provision_immich.py

1. First run: create the admin (admin@<domain>, the same address as Authentik's
   akadmin — the first OIDC login of akadmin is linked to it by e-mail).
2. Without IMMICH_API_KEY: log in with the password, create an API key → ONE line
   `IMMICH_KEY=…` on stdout, which setup.sh takes into .env via $(…) (never into a log).
3. With the key: login via Authentik (OIDC, auto-launch, auto-register, default quota)
   and password login OFF — from then on the key is the only admin access besides
   akadmin's SSO login.
Everything else goes to stderr. Never prints passwords or keys.
"""
import os
import sys
import time

import httpx

BASE = "http://immich-server:2283/api"
DOM = os.environ["ZELLE_DOMAIN"]
EMAIL = f"admin@{DOM}"
PW = os.environ["IMMICH_ADMIN_PASSWORD"]
KEY = os.environ.get("IMMICH_API_KEY", "").strip()
SECRET = os.environ["IMMICH_OIDC_SECRET"]
QUOTA = int(os.environ.get("IMMICH_DEFAULT_QUOTA_GB") or 5)


def log(*a):
    print(*a, file=sys.stderr)


with httpx.Client(timeout=30) as c:
    for _ in range(90):
        try:
            if c.get(f"{BASE}/server/ping").status_code == 200:
                break
        except httpx.HTTPError:
            pass
        time.sleep(5)
    else:
        sys.exit("Immich nicht erreichbar")

    if not c.get(f"{BASE}/server/config").json().get("isInitialized"):
        r = c.post(f"{BASE}/auth/admin-sign-up", json={"email": EMAIL, "password": PW, "name": "Zellen-Admin"})
        if r.status_code not in (200, 201):
            sys.exit(f"Admin nicht anlegbar: HTTP {r.status_code} {r.text[:200]}")
        log("  Immich: Admin angelegt")

    neu = None
    if KEY:
        h = {"x-api-key": KEY}
        if c.get(f"{BASE}/users/me", headers=h).status_code != 200:
            sys.exit("  ✗ Immich: IMMICH_API_KEY wird abgelehnt — Zeile aus .env entfernen und "
                     "Passwort-Login vorübergehend wieder einschalten")
    else:
        r = c.post(f"{BASE}/auth/login", json={"email": EMAIL, "password": PW})
        if r.status_code not in (200, 201):
            sys.exit(f"Admin-Anmeldung abgelehnt: HTTP {r.status_code} {r.text[:200]}")
        tok = {"Authorization": f"Bearer {r.json()['accessToken']}"}
        r = c.post(f"{BASE}/api-keys", headers=tok, json={"name": "claraos-zelle", "permissions": ["all"]})
        if r.status_code not in (200, 201) or not r.json().get("secret"):
            sys.exit(f"API-Schlüssel nicht erzeugbar: HTTP {r.status_code}")
        neu = r.json()["secret"]
        h = {"x-api-key": neu}
        log("  Immich: API-Schlüssel erzeugt")

    cfg = c.get(f"{BASE}/system-config", headers=h).json()
    soll = {
        "enabled": True,
        "issuerUrl": f"https://auth.{DOM}/application/o/immich/",
        "clientId": "immich",
        "clientSecret": SECRET,
        "scope": "openid email profile",
        "buttonText": "Mit ClaraOS anmelden",
        "autoRegister": True,
        "autoLaunch": True,
        "storageLabelClaim": "preferred_username",
        "defaultStorageQuota": QUOTA,
    }
    oauth = cfg["oauth"]
    geaendert = any(oauth.get(k) != v for k, v in soll.items())
    oauth.update(soll)
    if cfg["passwordLogin"]["enabled"]:
        cfg["passwordLogin"]["enabled"] = False
        geaendert = True
    if cfg["server"].get("externalDomain") != f"https://immich.{DOM}":
        cfg["server"]["externalDomain"] = f"https://immich.{DOM}"   # share links
        geaendert = True
    if geaendert:
        r = c.put(f"{BASE}/system-config", headers=h, json=cfg)
        if r.status_code != 200:
            sys.exit(f"Konfiguration abgelehnt: HTTP {r.status_code} {r.text[:300]}")
        log(f"  Immich: Anmeldung über Authentik, Passwort-Login aus, Kontingent {QUOTA} GB je Nutzer")
    else:
        log("  Immich: Konfiguration unverändert")

    if neu:
        print(f"IMMICH_KEY={neu}")
