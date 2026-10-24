#!/usr/bin/env python3
"""Shared social cell test (Mastodon + PeerTube) — from the user's perspective.

    ZELLE_TEST_PW=… python3 social_test.py <domain> <user>

1 Mastodon: login via single sign-on (OIDC), account created, not admin
2 Mastodon: private post → readable → deleted
3 PeerTube: login via single sign-on (OIDC plugin), account created, normal user with quota
4 Neither offers self-registration
Skipped when the cell does not host the social cell. Never prints passwords or tokens.
"""
import html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

from zelle_client import Zelle

DOM, USER = sys.argv[1], sys.argv[2]
BASIS = DOM.split(".", 1)[1]
SOCIAL, VIDEO = f"https://social.{BASIS}", f"https://video.{BASIS}"
z = Zelle(DOM)
z.anmelden(USER, os.environ["ZELLE_TEST_PW"])
print("0 Anmeldung                               ok")


def anfrage(method, url, body=None, headers=None, form=False):
    h = dict(headers or {})
    data = None
    if body is not None:
        if form:
            data = urllib.parse.urlencode(body).encode()
            h["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
    try:
        with z.op.open(urllib.request.Request(url, data=data, method=method, headers=h), timeout=60) as r:
            txt = r.read().decode() or "null"
            return r.status, (json.loads(txt) if txt.lstrip()[:1] in "[{" else txt), r.geturl()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300], url


s, _, _ = anfrage("GET", f"{SOCIAL}/api/v1/instance")
if s in (0, 502, 503) or s >= 500:
    print("SOCIAL-TEST ÜBERSPRUNGEN: keine Social-Zelle hier")
    sys.exit(0)

# ── 1 Mastodon login ────────────────────────────────────────────────────
r = z.get(f"{SOCIAL}/auth/sign_in")
seite = r.read().decode()
# The button is a link with data-method="post" (rails-ujs); the CSRF token is in <meta>.
assert 'href="/auth/auth/openid_connect"' in seite, "kein SSO-Anmeldeknopf auf der Mastodon-Anmeldeseite"
token = re.search(r'<meta name="csrf-token" content="([^"]+)"', seite).group(1)
start = urllib.request.Request(f"{SOCIAL}/auth/auth/openid_connect", method="POST",
                               data=urllib.parse.urlencode({"authenticity_token": html.unescape(token)}).encode(),
                               headers={"Content-Type": "application/x-www-form-urlencoded",
                                        "Referer": f"{SOCIAL}/auth/sign_in"})
rueck = z.oidc_rueckweg(start)
if "/auth/auth/openid_connect/callback" in rueck:
    rueck = z.get(rueck).geturl()
assert rueck.startswith(SOCIAL) and "/auth/sign_in" not in rueck, f"nicht angemeldet: {rueck.split('?')[0]}"
start_seite = z.get(f"{SOCIAL}/home").read().decode()
m = re.search(r'<script[^>]*id="initial-state"[^>]*>(.*?)</script>', start_seite, re.S)
assert m, "kein Anfangszustand (nicht angemeldet?)"
mtok = json.loads(m.group(1)).get("meta", {}).get("access_token")
assert mtok, "kein Zugriffsschlüssel im Anfangszustand"
mh = {"Authorization": f"Bearer {mtok}"}
s, me, _ = anfrage("GET", f"{SOCIAL}/api/v1/accounts/verify_credentials", headers=mh)
# Mastodon keeps only [a-z0-9_] of the user name: zelle-test -> zelletest, alice.b -> aliceb
MASTODON_NAME = re.sub(r"[^a-z0-9_]", "", USER.lower())
# (a taken name gets _1, _2 …)
assert s == 200 and re.fullmatch(re.escape(MASTODON_NAME) + r"(_\d+)?", me.get("username") or ""), \
    f"falsches Konto: {s} {me.get('username')}"
rolle = ((me.get("role") or {}).get("name") or "").lower()
assert rolle not in ("owner", "admin"), f"Testkonto ist {rolle}"
print(f"1 Mastodon: OIDC, @{MASTODON_NAME}, keine Admin-Rolle".ljust(41) + "ok")

# ── 2 private post ──────────────────────────────────────────────────────
marker = f"zelle-test {uuid.uuid4().hex[:10]}"
s, st, _ = anfrage("POST", f"{SOCIAL}/api/v1/statuses", {"status": marker, "visibility": "private"}, mh)
assert s == 200 and st.get("id"), f"Beitrag abgelehnt: {s} {str(st)[:200]}"
s, gl, _ = anfrage("GET", f"{SOCIAL}/api/v1/statuses/{st['id']}", headers=mh)
assert s == 200 and marker in (gl.get("content") or ""), "Beitrag nicht lesbar"
s, _, _ = anfrage("DELETE", f"{SOCIAL}/api/v1/statuses/{st['id']}", headers=mh)
assert s == 200, f"Löschen: {s}"
print("2 Mastodon: Beitrag → lesen → löschen     ok")

# ── 3 PeerTube login ────────────────────────────────────────────────────
s, cfg, _ = anfrage("GET", f"{VIDEO}/api/v1/config")
ext = [a for a in (cfg.get("plugin") or {}).get("registeredExternalAuths", []) if "openid" in a.get("npmName", "")]
assert ext, "PeerTube bietet keine SSO-Anmeldung an"
a = ext[0]
start_url = f"{VIDEO}/plugins/{a['name']}/{a['version']}/auth/{a['authName']}"
rueck = z.oidc_rueckweg(start_url)
if "/router/code-cb" in rueck:
    rueck = z.get(rueck).geturl()
q = urllib.parse.parse_qs(urllib.parse.urlparse(rueck).query)
assert q.get("externalAuthToken"), f"kein externer Anmeldeschlüssel: {rueck.split('?')[0]}"
s, cl, _ = anfrage("GET", f"{VIDEO}/api/v1/oauth-clients/local")
s, tok, _ = anfrage("POST", f"{VIDEO}/api/v1/users/token", {
    "client_id": cl["client_id"], "client_secret": cl["client_secret"], "grant_type": "password",
    "response_type": "code", "username": q["username"][0], "externalAuthToken": q["externalAuthToken"][0]},
    form=True)
assert s == 200 and tok.get("access_token"), f"PeerTube-Token abgelehnt: {s} {str(tok)[:150]}"
s, pme, _ = anfrage("GET", f"{VIDEO}/api/v1/users/me", headers={"Authorization": f"Bearer {tok['access_token']}"})
# PeerTube allows [a-z0-9._] — a hyphen becomes "_" (zelle-test -> zelle_test)
# (like Mastodon, PeerTube keeps deleted names reserved and appends -1, -2 …)
assert s == 200 and re.fullmatch(re.escape(re.sub(r"[^a-z0-9._]", "_", USER.lower())) + r"(-\d+)?",
                                 pme.get("username") or ""), \
    f"falsches PeerTube-Konto: {pme.get('username')}"
assert (pme.get("role") or {}).get("id") == 2, f"Rolle: {pme.get('role')}"
assert (pme.get("videoQuota") or 0) > 0, "kein Video-Kontingent"
print(f"3 PeerTube: OIDC, Nutzerrolle, {pme['videoQuota'] / 2**30:.0f} GB".ljust(41) + "ok")

# ── 4 no self-registration ──────────────────────────────────────────────
assert cfg.get("signup", {}).get("allowed") is False, "PeerTube erlaubt Selbstregistrierung"
fremd = urllib.request.build_opener()
try:
    seite = fremd.open(f"{SOCIAL}/auth/sign_up", timeout=30).read().decode()
except urllib.error.HTTPError:
    seite = ""
assert 'name="user[password]"' not in seite, "Mastodon zeigt ein Registrierungsformular"
print("4 Keine Selbstregistrierung               ok")
print("\nSOCIAL-TEST GRÜN")
