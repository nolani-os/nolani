"""OrangeHRM in a cell, through the real browser path: shell login → OrangeHRM tile →
straight to the cell's login and back → a NEW employee + user was created (role ESS) →
no user administration → may add an emergency contact for oneself (self-service).

    ZELLE_TEST_PW=… python3 orangehrm_test.py <domain> <user> <output dir>

The account must exist in the cell's Authentik (testkonto.py); run_tests.sh starts this
in the Playwright container and removes the OrangeHRM user and employee afterwards
(orangehrm_konto_weg.sh). Prints no passwords.
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

DOM, USER = sys.argv[1], sys.argv[2]
OUT = sys.argv[3] if len(sys.argv) > 3 else "orangehrm-test"
PW = os.environ["ZELLE_TEST_PW"]
SHELL = f"https://home.{DOM}"
APP = f"https://orangehrm.{DOM}"
os.makedirs(OUT, exist_ok=True)
bericht: dict = {"schritte": {}}


def schritt(name, ok, **info):
    bericht["schritte"][name] = {"ok": bool(ok), **info}
    print(("✓ " if ok else "✗ ") + name + (f" — {info}" if info else ""))
    return ok


def app_frame(page):
    return next((f for f in page.frames if f.url.startswith(APP)), None)


def im_dashboard(frame) -> bool:
    return frame is not None and "/dashboard/index" in frame.url


def api(frame, methode, pfad, body=None) -> dict:
    """OrangeHRM's own REST API, inside the frame (session cookie of the user)."""
    return frame.evaluate("""async ([m, p, b]) => {
        const r = await fetch('/web/index.php/api/v2' + p, {method: m, credentials: 'include',
            headers: b ? {'Content-Type': 'application/json'} : {},
            body: b ? JSON.stringify(b) : undefined});
        const j = await r.json().catch(() => ({}));
        return {status: r.status, data: j.data, fehler: r.ok ? null : JSON.stringify(j).slice(0, 200)};
    }""", [methode, pfad, body])


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, locale="de-DE")
    page = ctx.new_page()

    # 1. Shell login through Authentik (same pattern as sicht_test.py)
    page.goto(SHELL + "/", wait_until="domcontentloaded")
    page.wait_for_selector("input[name=uidField]", timeout=60000)
    page.fill("input[name=uidField]", USER)
    if page.locator("input[name=password]").count():
        page.fill("input[name=password]", PW)
    page.click("button[type=submit]")
    try:
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
            break
        page.wait_for_timeout(1000)
    if not schritt("anmeldung_shell", page.url.startswith(SHELL)):
        page.screenshot(path=f"{OUT}/fehler-anmeldung.png")
        sys.exit(1)
    page.wait_for_timeout(5000)

    # 2. Tile → the login page goes straight to the cell (one OIDC provider) and back
    t0 = time.time()
    page.goto(f"{SHELL}/?app=orangehrm", wait_until="domcontentloaded")
    frame = None
    for _ in range(90):
        frame = app_frame(page)
        if im_dashboard(frame):
            break
        page.wait_for_timeout(1000)
    page.wait_for_timeout(4000)
    page.screenshot(path=f"{OUT}/01-angemeldet.png")
    if not schritt("angemeldet_ueber_zelle", im_dashboard(frame), sekunden=round(time.time() - t0),
                   url=(frame.url.split("?")[0] if frame else None)):
        sys.exit(1)

    # 3. Who am I: a new employee, created by the first login
    ich = api(frame, "GET", "/pim/myself")
    d = ich.get("data") or {}
    emp = d.get("empNumber")
    schritt("neuer_mitarbeiter", ich.get("status") == 200 and emp,
            emp=emp, mitarbeiter=" ".join(filter(None, [d.get("firstName"), d.get("lastName")])))

    # 4. Role ESS: user administration is refused
    verw = api(frame, "GET", "/admin/users?limit=1")
    schritt("keine_nutzerverwaltung", verw.get("status") in (401, 403), status=verw.get("status"))

    # 5. Self-service works: an emergency contact for oneself
    marke = f"Nolani-Test {int(time.time())}"
    neu = api(frame, "POST", f"/pim/employees/{emp}/emergency-contacts",
              {"name": marke, "relationship": "Test", "homePhone": "0123456",
               "officePhone": "", "mobilePhone": ""}) if emp else {}
    schritt("notfallkontakt_anlegen", neu.get("status") == 200 and (neu.get("data") or {}).get("name") == marke,
            status=neu.get("status"), fehler=neu.get("fehler"))

    # 6. Second visit: straight in, no login
    page.goto(f"{SHELL}/?app=orangehrm", wait_until="domcontentloaded")
    zweit = False
    for _ in range(40):
        if im_dashboard(app_frame(page)):
            zweit = True
            break
        page.wait_for_timeout(1000)
    page.screenshot(path=f"{OUT}/02-zweiter-aufruf.png")
    schritt("zweiter_aufruf_ohne_login", zweit)
    b.close()

json.dump(bericht, open(f"{OUT}/bericht.json", "w"), indent=2, ensure_ascii=False)
sys.exit(0 if all(s["ok"] for s in bericht["schritte"].values()) else 1)
