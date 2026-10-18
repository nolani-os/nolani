#!/usr/bin/env python3
"""Login test for a cell — the whole chain, the way a browser walks it.

Basis for the isolation test.

  shell → forward_auth → Authentik flow (identifier, password) → back to the shell
  → /api/claraos/me must return the user AND profil=cell.

Run on the cell (password ONLY via the environment, never as an argument):
    ZELLE_TEST_PW=… python3 login_test.py <domain> <user>
No third-party libraries (urllib + CookieJar). Never prints the password or cookies.
"""
import http.cookiejar
import json
import os
import sys
import urllib.parse
import urllib.request

DOM, USER = sys.argv[1], sys.argv[2]
PW = os.environ["ZELLE_TEST_PW"]
SHELL = f"https://home.{DOM}"
AUTH = f"https://auth.{DOM}"

jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
op.addheaders = [("User-Agent", "claraos-zelle-login-test/1")]


def get(url, **kw):
    return op.open(urllib.request.Request(url, **kw), timeout=30)


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    csrf = next((c.value for c in jar if c.name == "authentik_csrf"), "")
    r = urllib.request.Request(f"{AUTH}{path}", data=data, method=method, headers={
        "Content-Type": "application/json", "Accept": "application/json",
        "X-authentik-CSRF": csrf, "Referer": AUTH + "/"})
    with op.open(r, timeout=30) as resp:
        return json.loads(resp.read().decode() or "{}")


# 1. Shell without a session → ends up (via redirects) in the login flow
r = get(SHELL + "/")
landed = r.geturl()
assert landed.startswith(AUTH), f"keine Weiterleitung zur Anmeldung: {landed}"
q = urllib.parse.urlparse(landed).query
nxt = urllib.parse.parse_qs(q).get("next", [""])[0]
print("1 Weiterleitung zur Anmeldung            ok")

# 2. Flow executor: identifier, then password (combined, depending on stage configuration)
flow = "default-authentication-flow"
path = f"/api/v3/flows/executor/{flow}/?query=" + urllib.parse.quote(q)
ch = api("GET", path)
for _ in range(6):
    comp = ch.get("component")
    if comp == "ak-stage-identification":
        body = {"component": comp, "uid_field": USER}
        if ch.get("password_fields"):
            body["password"] = PW
        ch = api("POST", path, body)
    elif comp == "ak-stage-password":
        ch = api("POST", path, {"component": comp, "password": PW})
    elif comp == "xak-flow-redirect":
        break
    else:
        sys.exit(f"unerwartete Stage: {comp} {json.dumps(ch.get('response_errors', {}))[:200]}")
assert ch.get("component") == "xak-flow-redirect", f"Anmeldung nicht abgeschlossen: {ch.get('component')}"
print("2 Anmeldung (Kennung + Passwort)         ok")

# 3. Back to the shell (authorization + outpost callback set the proxy session)
ziel = ch.get("to") or nxt or SHELL + "/"
if ziel.startswith("/"):
    ziel = AUTH + ziel
r = get(ziel)
assert r.geturl().startswith(SHELL), f"nicht zurück in der Shell: {r.geturl()}"
print("3 Rückleitung in die Shell               ok")

# 4. /me — identity from the trusted headers + deployment profile
me = json.loads(get(SHELL + "/api/claraos/me").read().decode())
assert me.get("username") == USER, f"/me meldet {me.get('username')!r}"
assert me.get("profil") == "cell", f"/me profil={me.get('profil')!r}"
print(f"4 /api/claraos/me: {me.get('username')}, profil={me.get('profil')}, rolle={me.get('role')}  ok")

# 5. Home-only paths do not exist in the cell. /containers is also an admin path —
#    the API's admin guard answers a non-admin with 403 BEFORE routing;
#    /devices has no such guard and must return 404 (router removed).
for pfad, erlaubt in (("/api/claraos/devices", {404}), ("/api/claraos/containers/hosts", {403, 404})):
    try:
        get(SHELL + pfad)
        sys.exit(f"5 Heim-Pfad {pfad} erreichbar — FEHLER")
    except urllib.error.HTTPError as e:
        assert e.code in erlaubt, f"Heim-Pfad {pfad}: HTTP {e.code}"
        print(f"5 Heim-Pfad {pfad} → {e.code}".ljust(41) + "ok")

# 6. Tiles: only the cell's set
apps = json.loads(get(SHELL + "/api/claraos/apps").read().decode())
ids = sorted(a.get("id") for a in (apps if isinstance(apps, list) else apps.get("apps", [])))
print(f"6 Kacheln ({len(ids)}): {', '.join(ids)}")
print("\nANMELDE-TEST GRÜN")
