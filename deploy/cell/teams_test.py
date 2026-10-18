#!/usr/bin/env python3
"""Teams-Test einer Zelle (Schicht 4) — Matrix wie die Teams-App (matrixClient.ts).

    ZELLE_TEST_PW=… python3 teams_test.py <domain> <benutzer>

1 Matrix-Token über /api/claraos/auth-proxy/element (Admin-Mint durch clara.bot)
2 whoami gegen https://matrix.<domain>
3 Upgrade auf ein echtes Gerät (MSC3882: login/get_token → m.login.token)
4 Raum anlegen → Nachricht senden → lesen → Raum verlassen
5 Synapse-Admin-API ist von außen gesperrt
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

from zelle_client import Zelle

DOM, USER = sys.argv[1], sys.argv[2]
HS = f"https://matrix.{DOM}"
z = Zelle(DOM)
z.anmelden(USER, os.environ["ZELLE_TEST_PW"])


def mx(method, path, token=None, body=None):
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    r = urllib.request.Request(HS + path, method=method, headers=h,
                               data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(r, timeout=30) as resp:
        return json.loads(resp.read().decode() or "{}")


d = z.get_json("/api/claraos/auth-proxy/element")
tok, uid = d.get("access_token"), d.get("user_id")
assert tok and uid, f"kein Matrix-Token: reason={d.get('reason')} error={d.get('error')}"
assert uid == f"@{USER}:{DOM}", f"MXID {uid}"
print(f"1 Matrix-Token für {uid}".ljust(41) + "ok")

assert mx("GET", "/_matrix/client/v3/account/whoami", tok).get("user_id") == uid
print("2 whoami                                  ok")

lt = mx("POST", "/_matrix/client/v1/login/get_token", tok, {})["login_token"]
sess = mx("POST", "/_matrix/client/v3/login", None,
          {"type": "m.login.token", "token": lt, "initial_device_display_name": "Zelle-Test"})
dev_tok = sess["access_token"]
assert sess.get("device_id"), "kein Gerät"
print(f"3 Gerät {sess['device_id']} (MSC3882)".ljust(41) + "ok")

raum = mx("POST", "/_matrix/client/v3/createRoom", dev_tok, {"name": "Zelle-Test", "preset": "private_chat"})["room_id"]
text = f"Zelle-Teams-Test {int(time.time())}"
mx("PUT", f"/_matrix/client/v3/rooms/{raum}/send/m.room.message/t{int(time.time()*1000)}", dev_tok,
   {"msgtype": "m.text", "body": text})
msgs = mx("GET", f"/_matrix/client/v3/rooms/{raum}/messages?dir=b&limit=10", dev_tok)
assert any((e.get("content") or {}).get("body") == text for e in msgs.get("chunk", [])), "Nachricht nicht gelesen"
mx("POST", f"/_matrix/client/v3/rooms/{raum}/leave", dev_tok, {})
mx("POST", f"/_matrix/client/v3/rooms/{raum}/forget", dev_tok, {})
mx("POST", "/_matrix/client/v3/logout", dev_tok, {})
print("4 Raum → Nachricht → lesen → verlassen     ok")

try:
    urllib.request.urlopen(HS + "/_synapse/admin/v1/server_version", timeout=15)
    raise AssertionError("Synapse-Admin-API von außen erreichbar!")
except urllib.error.HTTPError as e:
    assert e.code == 404, f"Admin-API: HTTP {e.code}"
print("5 Admin-API von außen → 404              ok")
print("\nTEAMS-TEST GRÜN")
