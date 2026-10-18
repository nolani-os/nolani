#!/usr/bin/env python3
"""Open WebUI einer Zelle einrichten — idempotent. Läuft im claraos-api-Container.

    docker compose exec -T -e OWUI_ADMIN_PASSWORD -e ZELLE_DOMAIN claraos-api \
        python3 - < owui_bootstrap.py

1. Admin anlegen (erste Registrierung) bzw. anmelden, wenn es ihn schon gibt
2. API-Schlüssel des Admins holen/erzeugen  → EINE Zeile `OWUI_KEY=…` auf stdout,
   die setup.sh per $(…) in die .env übernimmt (nie ins Log)
3. Selbstregistrierung abschalten — Open WebUI ist zwar nur intern erreichbar,
   aber eine offene Registrierung wäre ein zweiter Weg an Konten vorbei.
Alles andere geht auf stderr.
"""
import os
import sys
import time

import httpx

BASE = "http://open-webui:8080"
DOM = os.environ["ZELLE_DOMAIN"]
EMAIL = f"admin@{DOM}"
PW = os.environ["OWUI_ADMIN_PASSWORD"]


def log(*a):
    print(*a, file=sys.stderr)


with httpx.Client(timeout=30) as c:
    for _ in range(60):
        try:
            if c.get(f"{BASE}/health").status_code == 200:
                break
        except httpx.HTTPError:
            pass
        time.sleep(5)
    else:
        sys.exit("Open WebUI nicht erreichbar")

    r = c.post(f"{BASE}/api/v1/auths/signin", json={"email": EMAIL, "password": PW})
    if r.status_code != 200:
        r = c.post(f"{BASE}/api/v1/auths/signup", json={"name": "Zellen-Admin", "email": EMAIL, "password": PW})
        if r.status_code != 200:
            sys.exit(f"Admin weder anmeldbar noch anlegbar: HTTP {r.status_code} {r.text[:200]}")
        log("  Open WebUI: Admin angelegt")
    else:
        log("  Open WebUI: Admin vorhanden")
    d = r.json()
    if d.get("role") != "admin":
        sys.exit(f"Konto {EMAIL} ist nicht admin (role={d.get('role')})")
    h = {"Authorization": f"Bearer {d['token']}"}

    r = c.get(f"{BASE}/api/v1/auths/api_key", headers=h)
    key = r.json().get("api_key") if r.status_code == 200 else None
    if not key:
        r = c.post(f"{BASE}/api/v1/auths/api_key", headers=h)
        if r.status_code != 200:
            sys.exit(f"API-Schlüssel nicht erzeugbar: HTTP {r.status_code} {r.text[:200]}")
        key = r.json()["api_key"]
        log("  Open WebUI: API-Schlüssel erzeugt")

    cfg = c.get(f"{BASE}/api/v1/auths/admin/config", headers=h)
    if cfg.status_code == 200:
        conf = cfg.json()
        if conf.get("ENABLE_SIGNUP"):
            conf["ENABLE_SIGNUP"] = False
            r = c.post(f"{BASE}/api/v1/auths/admin/config", headers=h, json=conf)
            log(f"  Open WebUI: Selbstregistrierung {'aus' if r.status_code == 200 else 'NICHT abgeschaltet (HTTP %d)' % r.status_code}")
        else:
            log("  Open WebUI: Selbstregistrierung ist aus")

    models = c.get(f"{BASE}/api/models", headers={"Authorization": f"Bearer {key}"})
    ids = [m.get("id") for m in (models.json().get("data", []) if models.status_code == 200 else [])]
    log(f"  Open WebUI sieht Modelle: {', '.join(ids) or '— keine —'}")

    print(f"OWUI_KEY={key}")
