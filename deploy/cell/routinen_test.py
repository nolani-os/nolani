#!/usr/bin/env python3
"""Routines test for a cell — recurring tasks for Clara through the external brain.

    ZELLE_TEST_PW=… python3 routinen_test.py <domain> <user>

1 Reading routine: runs now, finishes with a result, result arrives as a notification
2 Changing routine: Clara asks to create a task — the task is NOT created, the run waits
  with a proposal
3 Approving the proposal creates the task (as the user); discarding works too
4 Clean up (task, routines)
Needs a connected brain (otherwise skipped with a clear message). Never prints passwords.
"""
import os
import sys
import time
import uuid

from zelle_client import Zelle

DOM, USER = sys.argv[1], sys.argv[2]
R, P = "/api/claraos/routinen", "/api/claraos/planner"
z = Zelle(DOM)
z.anmelden(USER, os.environ["ZELLE_TEST_PW"])
print("0 Anmeldung                               ok")
if not z.get_json(f"{R}/status").get("gehirn"):
    print("ROUTINEN-TEST ÜBERSPRUNGEN: kein Gehirn angebunden")
    sys.exit(0)
marker = f"Routine-Test {uuid.uuid4().hex[:8]}"


def warte_auf_lauf(rid: str, sekunden: int = 240) -> dict:
    for _ in range(sekunden // 5):
        laeufe = z.get_json(f"{R}/{rid}/laeufe")
        if laeufe and laeufe[0]["status"] != "laeuft":
            return laeufe[0]
        time.sleep(5)
    raise AssertionError(f"Lauf nach {sekunden} s nicht fertig")


def aufgaben_mit(text: str) -> list:
    out = []
    for p in z.get_json(f"{P}/api/projects"):
        out += [t for t in z.get_json(f"{P}/api/projects/{p['id']}/tasks") if text in (t.get("title") or "")]
    return out


angelegt = []
try:
    # ── 1 reading routine ───────────────────────────────────────────────
    r1 = z.send_json("POST", R, {"titel": "Test lesen", "rhythmus": "taeglich", "uhrzeit": "03:17",
                                 "auftrag": "Wie viele Projekte habe ich im Planner? Antworte nur mit der Zahl."})
    angelegt.append(r1["id"])
    seit = max([m["id"] for m in z.get_json("/api/claraos/meldungen")["meldungen"]] or [0])
    z.send_json("POST", f"{R}/{r1['id']}/jetzt", {})
    l1 = warte_auf_lauf(r1["id"])
    assert l1["status"] == "fertig", f"Lauf: {l1['status']} — {(l1.get('ergebnis') or '')[:200]}"
    assert (l1.get("ergebnis") or "").strip(), "kein Ergebnis"
    neu = z.get_json("/api/claraos/meldungen", seit=seit)["meldungen"]
    assert any(m["titel"] == "Test lesen" for m in neu), "keine Meldung in der Glocke"
    print(f"1 Lesende Routine → Ergebnis + Meldung".ljust(41) + "ok")

    # ── 2 changing routine → proposal, nothing created ──────────────────
    r2 = z.send_json("POST", R, {"titel": "Test ändern", "rhythmus": "taeglich", "uhrzeit": "03:18",
                                 "auftrag": f"Lege im Planner eine Aufgabe mit dem Titel „{marker}“ an."})
    angelegt.append(r2["id"])
    z.send_json("POST", f"{R}/{r2['id']}/jetzt", {})
    l2 = warte_auf_lauf(r2["id"])
    offen = [i for i, v in enumerate(l2["vorschlaege"]) if v["status"] == "offen"]
    assert l2["status"] == "wartet" and offen, f"kein offener Vorschlag: {l2['status']} {l2['vorschlaege']}"
    assert any(l2["vorschlaege"][i]["werkzeug"] in ("create_task", "create_project_from_plan") for i in offen), \
        f"Vorschlag ist kein Anlegen: {[l2['vorschlaege'][i]['werkzeug'] for i in offen]}"
    assert not aufgaben_mit(marker), "Aufgabe wurde OHNE Freigabe angelegt!"
    print(f"2 Ändernde Routine → {len(offen)} Vorschlag, nichts angelegt".ljust(41) + "ok")

    # ── 3 approve the create, discard the rest ──────────────────────────
    erster = next(i for i in offen if l2["vorschlaege"][i]["werkzeug"] == "create_task") \
        if any(l2["vorschlaege"][i]["werkzeug"] == "create_task" for i in offen) else offen[0]
    v = z.send_json("POST", f"{R}/laeufe/{l2['id']}/vorschlaege/{erster}", {"freigeben": True})
    assert v["status"] == "ausgefuehrt", f"Freigabe: {v.get('status')} {v.get('antwort', '')[:200]}"
    assert aufgaben_mit(marker), "Aufgabe nach Freigabe nicht da"
    for i in offen:
        if i != erster:
            z.send_json("POST", f"{R}/laeufe/{l2['id']}/vorschlaege/{i}", {"freigeben": False})
    l2b = z.get_json(f"{R}/{r2['id']}/laeufe")[0]
    assert l2b["status"] == "erledigt", f"Lauf danach: {l2b['status']}"
    print("3 Freigabe legt an, Lauf erledigt         ok")
finally:
    # ── 4 clean up ──────────────────────────────────────────────────────
    for t in aufgaben_mit(marker):
        z.send_json("DELETE", f"{P}/api/tasks/{t['id']}", {})
    for rid in angelegt:
        z.send_json("DELETE", f"{R}/{rid}", {})
print("4 aufgeräumt")
print("\nROUTINEN-TEST GRÜN")
