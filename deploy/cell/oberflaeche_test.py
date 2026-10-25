#!/usr/bin/env python3
"""The assistant drives the user's screen — real browser, real shell, real brain.

Runs in the Playwright container (run_tests.sh oberflaeche):
    ZELLE_TEST_PW=… python3 oberflaeche_test.py <domain> <user> <output_dir>

Each step is a plain chat request ("open the planner"); what counts is what the
shell then really shows — the open windows in its window store — never the
assistant's answer. Result: PNGs + bericht.json. Never prints passwords.
"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

DOM, USER, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
PW = os.environ["ZELLE_TEST_PW"]
SHELL = f"https://home.{DOM}"
DATEI = "/oberflaeche-test.txt"
os.makedirs(OUT, exist_ok=True)


def fenster(page) -> list[str]:
    """App ids of the open, not minimised windows (the shell's own store)."""
    return page.evaluate("""() => Object.values(window.__claraos.windows.getState().windows)
        .filter(w => !w.minimized).map(w => w.appId)""")


def frage(page, text: str) -> None:
    # Not an editor's hidden input (Monaco keeps a readonly textarea that counts as visible)
    feld = page.locator("textarea:visible:not([readonly])").first
    feld.fill(text)
    knopf = page.locator("button[aria-label^='Send']:visible, button[title='Senden']:visible").first
    if knopf.count():
        knopf.click()
    else:
        feld.press("Enter")


def warte(page, bedingung, sekunden: int = 120) -> bool:
    for _ in range(sekunden // 2):
        page.wait_for_timeout(2000)
        if bedingung(fenster(page)):
            page.wait_for_timeout(3000)  # let the answer finish before the next request
            return True
    return False


def anmelden(page) -> None:
    page.goto(SHELL + "/", wait_until="domcontentloaded")
    page.wait_for_selector("input[name=uidField]", timeout=30000)
    page.fill("input[name=uidField]", USER)
    if page.locator("input[name=password]").count():
        page.fill("input[name=password]", PW)
    page.click("button[type=submit]")
    try:  # second step: wait for it, fill, verify the value stuck, then click
        page.wait_for_selector("text=Nicht Sie?", timeout=15000)
        page.wait_for_timeout(1000)
        for _ in range(3):
            feld = page.locator("input[name=password]")
            feld.fill(PW)
            page.wait_for_timeout(300)
            if feld.input_value() == PW:
                page.click("button[type=submit]")
                break
    except Exception:
        pass
    for _ in range(90):
        if page.url.startswith(SHELL):
            return
        page.wait_for_timeout(1000)
    raise SystemExit(f"Anmeldung nicht abgeschlossen, hängt bei {page.url.split('?')[0]}")


# (name, request, condition on the open windows)
SCHRITTE = [
    ("planner", "Öffne bitte den Planner.", lambda f: "planner" in f),
    ("teams", "Öffne Teams.", lambda f: "teams-workspace" in f),
    ("teams_zu", "Schließ Teams wieder.", lambda f: "teams-workspace" not in f),
    ("fotos", "Öffne meine Fotos.", lambda f: "immich" in f),
    ("datei", f"Öffne die Datei {DATEI} aus meinen Dateien im Betrachter.",
     lambda f: "text-editor" in f),
    ("dateien_app", "Zeig mir den obersten Ordner meiner Dateien in der Dateien-App.",
     lambda f: "files" in f),
]

bericht: dict = {"schritte": {}}
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome")
    page = b.new_context(viewport={"width": 1440, "height": 900}, locale="de-DE").new_page()
    anmelden(page)
    page.wait_for_timeout(6000)
    page.evaluate("""async (pfad) => { await fetch('/api/claraos/files/v2/write', {method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({source: 'nextcloud', path: pfad, content: 'Hallo aus dem Oberflächentest.'})}); }""",
                  DATEI)
    page.goto(f"{SHELL}/?chat=1", wait_until="domcontentloaded")
    page.wait_for_timeout(6000)
    for name, text, bedingung in SCHRITTE:
        vorher = fenster(page)
        frage(page, text)
        ok = warte(page, bedingung)
        bericht["schritte"][name] = {"ok": ok, "vorher": vorher, "nachher": fenster(page)}
        page.screenshot(path=f"{OUT}/{name}.png")
        print(f"  {'✓' if ok else '✗'} {name}: {text} → {fenster(page)}", flush=True)
    page.evaluate("""async (pfad) => { await fetch('/api/claraos/files/v2/delete?source=nextcloud&path='
        + encodeURIComponent(pfad), {method: 'DELETE'}); }""", DATEI)
    b.close()

json.dump(bericht, open(f"{OUT}/bericht.json", "w"), ensure_ascii=False, indent=1)
gut = all(s["ok"] for s in bericht["schritte"].values())
print("OBERFLAECHE GRÜN" if gut else "OBERFLAECHE ROT")
sys.exit(0 if gut else 1)
