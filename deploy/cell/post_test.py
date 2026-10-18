#!/usr/bin/env python3
"""Post-Test einer Zelle (Schicht 4) — Post-App über die ClaraOS-API (JMAP zu Stalwart).

    ZELLE_TEST_PW=… python3 post_test.py <domain> <benutzer>

1 Postfächer (eigener Postfach-Zugang, JMAP über jmap.<domain>)
2 Absender-Identität
3 Mail an sich selbst senden → im Posteingang wiederfinden (interne Zustellung)
"""
import os
import sys
import time

from zelle_client import Zelle

DOM, USER = sys.argv[1], sys.argv[2]
z = Zelle(DOM)
z.anmelden(USER, os.environ["ZELLE_TEST_PW"])
P = "/api/claraos/post"

mb = z.get_json(f"{P}/mailboxes")
boxen = mb.get("mailboxes", mb) if isinstance(mb, dict) else mb
rollen = sorted({(b.get("role") or "") for b in boxen} - {""})
assert "inbox" in rollen, f"kein Posteingang: {rollen}"
print(f"1 Postfächer: {len(boxen)} ({', '.join(rollen)})".ljust(41) + "ok")

ids = z.get_json(f"{P}/identities")
ident = (ids.get("identities") or [None])[0]
assert ident, f"keine Identität: {ids}"
addr = ident.get("email")
assert addr == f"{USER}@{DOM}", f"Identität {addr}"
print(f"2 Identität: {addr}".ljust(41) + "ok")

betreff = f"Zelle-Post-Test {int(time.time())}"
z.send_json("POST", f"{P}/send", {"identity_id": ident["id"], "to": [{"email": addr}],
                                 "subject": betreff, "text": "Interne Zustellung in der Zelle.",
                                 "delay_s": 0})
for _ in range(20):
    msgs = z.get_json(f"{P}/messages", q=betreff, threads="false")
    liste = msgs.get("messages", msgs) if isinstance(msgs, dict) else msgs
    if any((m.get("subject") or "") == betreff for m in liste):
        break
    time.sleep(2)
else:
    raise AssertionError("Mail nicht im Posteingang angekommen")
print("3 Senden → im Posteingang angekommen      ok")
print("\nPOST-TEST GRÜN")
