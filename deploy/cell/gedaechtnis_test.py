#!/usr/bin/env python3
"""Memory test for a cell with an external brain — through the ClaraOS API, like the frontend.

    ZELLE_TEST_PW=… python3 gedaechtnis_test.py <domain> <user>

1 Tell Clara a unique fact in one chat.
2 Ask for it in a NEW chat (no shared history): the answer can only come from the
  brain's per-user memory. Memory extraction runs in the background, so retry.
Forgetting is checked by run_tests.sh when it deletes the test account.
Costs a few cents.
"""
import json
import os
import random
import sys
import time
import urllib.request

from zelle_client import Zelle

DOM, USER = sys.argv[1], sys.argv[2]
z = Zelle(DOM)
z.anmelden(USER, os.environ["ZELLE_TEST_PW"])


def frage(text: str) -> str:
    body = {"model": "clara/everyday", "stream": True,
            "messages": [{"role": "user", "content": text}], "meta": {}}
    r = urllib.request.Request(z.shell + "/api/claraos/chat/v2/completions",
                               data=json.dumps(body).encode(), method="POST",
                               headers={"Content-Type": "application/json",
                                        "Accept": "text/event-stream"})
    out = []
    with z.op.open(r, timeout=180) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:") or line == "data: [DONE]":
                continue
            try:
                d = json.loads(line[5:].strip())
            except ValueError:
                continue
            for ch in d.get("choices", []):
                out.append((ch.get("delta") or {}).get("content") or "")
    return "".join(out)


zahl = str(random.randint(1000, 9999))
# Deliberately the hard case: an explicit "remember this" with a one-word reply.
# The brain must store it although the reply is short.
a = frage(f"Merk dir bitte dauerhaft: Meine Lieblingszahl ist {zahl}. Antworte nur mit OK.")
print(f"1 Fakt mitgeteilt (Lieblingszahl {zahl})".ljust(41) + "ok")

for versuch in range(1, 7):
    time.sleep(15)
    a = frage("Neue Frage ohne Vorgeschichte: Was ist meine Lieblingszahl? "
              "Antworte nur mit der Zahl oder mit 'unbekannt'.")
    if zahl in a:
        print(f"2 neuer Chat kennt die Zahl (Versuch {versuch})".ljust(41) + "ok")
        print("\nGEDAECHTNIS-TEST GRÜN")
        sys.exit(0)
    print(f"  Versuch {versuch}: noch nicht erinnert")
print(f"✗ Clara erinnert sich nicht an {zahl}")
sys.exit(1)
