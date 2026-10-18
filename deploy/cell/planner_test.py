#!/usr/bin/env python3
"""Planner-Test einer Zelle (Schicht 3) — Aufgaben (Vikunja) + Termine (Nextcloud-CalDAV).

    ZELLE_TEST_PW=… python3 planner_test.py <domain> <benutzer>

1 Projekte über den Planner-BFF (eigenes Vikunja-Token des Nutzers)
2 Aufgabe anlegen → in der Liste sehen → löschen
3 Termin anlegen (CalDAV bei Nextcloud) → wiederfinden → löschen
"""
import json
import os
import sys
import time
import urllib.parse
from datetime import datetime, timedelta

from zelle_client import Zelle

DOM, USER = sys.argv[1], sys.argv[2]
z = Zelle(DOM)
z.anmelden(USER, os.environ["ZELLE_TEST_PW"])
P = "/api/claraos/planner"

projekte = z.get_json(f"{P}/api/projects")
if not projekte:
    projekte = [z.send_json("PUT", f"{P}/api/projects", {"title": "Zelle-Test"})]
pid = projekte[0]["id"]
print(f"1 Projekte: {len(projekte)} (z.B. „{projekte[0].get('title')}“)".ljust(41) + "ok")

titel = f"Zelle-Test {int(time.time())}"
t = z.send_json("PUT", f"{P}/api/projects/{pid}/tasks", {"title": titel})
tasks = z.get_json(f"{P}/api/projects/{pid}/tasks")
assert any(x.get("title") == titel for x in tasks), "Aufgabe nicht in der Liste"
z.send_json("DELETE", f"{P}/api/tasks/{t['id']}", {})
print("2 Aufgabe anlegen → sehen → löschen       ok")

morgen = (datetime.now() + timedelta(days=1)).replace(hour=10, minute=0, second=0, microsecond=0)
ev = z.send_json("POST", f"{P}/events", {
    "summary": titel, "start": morgen.isoformat(), "end": (morgen + timedelta(hours=1)).isoformat()})
uid = ev.get("uid") or ev.get("event", {}).get("uid")
assert uid, f"keine uid in der Antwort: {list(ev)}"
von = morgen.replace(hour=0).isoformat()
bis = (morgen + timedelta(days=1)).replace(hour=0).isoformat()
liste = z.get_json(f"{P}/events", start=von, end=bis)
assert titel in json.dumps(liste, ensure_ascii=False), "Termin nicht wiedergefunden"
z.send_json("DELETE", f"{P}/events/{urllib.parse.quote(uid)}", {})
print("3 Termin anlegen → finden → löschen       ok")
print("\nPLANNER-TEST GRÜN")
