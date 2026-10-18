#!/usr/bin/env python3
"""Anruf-Test Teil 1 (auf der Zelle): LiveKit-Token so beschaffen wie Element Call.

    ZELLE_TEST_PW=… python3 anruf_test.py <domain> <benutzer> <ausgabedatei>

1 Matrix-Token über /api/claraos/auth-proxy/element
2 OpenID-Token (POST /_matrix/client/v3/user/<mxid>/openid/request_token)
3 lk-jwt-service: OpenID → LiveKit-Token (POST matrix.<domain>/livekit/jwt/sfu/get) —
  dafür prüft lk-jwt die Identität über /_matrix/federation/v1/openid/userinfo
Schreibt {url, jwt, room} in die Ausgabedatei (0600) für Teil 2 (Beitritt von außen).
Gibt das Token nie aus.
"""
import json
import os
import sys
import time
import urllib.request

from zelle_client import Zelle

DOM, USER, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
z = Zelle(DOM)
z.anmelden(USER, os.environ["ZELLE_TEST_PW"])
HS = f"https://matrix.{DOM}"


def post(url, body, token=None):
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    r = urllib.request.Request(url, method="POST", data=json.dumps(body).encode(), headers=h)
    with urllib.request.urlopen(r, timeout=30) as resp:
        return json.loads(resp.read().decode())


d = z.get_json("/api/claraos/auth-proxy/element")
tok, uid = d["access_token"], d["user_id"]
print(f"1 Matrix-Token für {uid}".ljust(41) + "ok")

oid = post(f"{HS}/_matrix/client/v3/user/{urllib.request.quote(uid)}/openid/request_token", {}, tok)
assert oid.get("access_token") and oid.get("matrix_server_name") == DOM, f"OpenID: {list(oid)}"
print("2 OpenID-Token                            ok")

raum = f"!zelle-anruf-{int(time.time())}:{DOM}"
lk = post(f"{HS}/livekit/jwt/sfu/get", {"room": raum, "openid_token": oid, "device_id": "ZELLETEST"})
assert lk.get("jwt") and lk.get("url"), f"lk-jwt: {list(lk)}"
print(f"3 LiveKit-Token von lk-jwt, url={lk['url']}".ljust(41) + " ok")

fd = os.open(OUT, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump({"url": lk["url"], "jwt": lk["jwt"], "room": raum}, f)
print("\nANRUF-TOKEN-TEST GRÜN")
