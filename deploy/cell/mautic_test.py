"""Mautic in a cell, through the real browser path: shell login → Mautic tile → signed in
via the cell (SAML) → no user administration → may create a contact.

    ZELLE_TEST_PW=… python3 mautic_test.py <domain> <user> <output dir>

The account must exist in the cell's Authentik (testkonto.py); run_tests.sh starts this
in the Playwright container and removes the Mautic account and the test contact
afterwards (mautic_konto_weg.php). Prints no passwords.
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

DOM, USER = sys.argv[1], sys.argv[2]
OUT = sys.argv[3] if len(sys.argv) > 3 else "mautic-test"
PW = os.environ["ZELLE_TEST_PW"]
SHELL = f"https://home.{DOM}"
APP = f"https://mautic.{DOM}"
os.makedirs(OUT, exist_ok=True)
bericht: dict = {"schritte": {}}


def schritt(name, ok, **info):
    bericht["schritte"][name] = {"ok": bool(ok), **info}
    print(("✓ " if ok else "✗ ") + name + (f" — {info}" if info else ""))
    return ok


def app_frame(page):
    return next((f for f in page.frames if f.url.startswith(APP)), None)


def im_dashboard(frame) -> bool:
    return frame is not None and "/s/dashboard" in frame.url and "/s/login" not in frame.url


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

    # 2. Tile → Mautic sends the unknown visitor straight to the cell (SAML) and back
    t0 = time.time()
    page.goto(f"{SHELL}/?app=mautic", wait_until="domcontentloaded")
    frame = None
    for _ in range(90):
        frame = app_frame(page)
        if im_dashboard(frame):
            break
        page.wait_for_timeout(1000)
    page.wait_for_timeout(3000)
    page.screenshot(path=f"{OUT}/01-angemeldet.png")
    if not schritt("angemeldet_ueber_zelle", im_dashboard(frame), sekunden=round(time.time() - t0),
                   url=(frame.url.split("?")[0] if frame else None)):
        sys.exit(1)

    # 3. A normal account: user administration is refused
    verwaltung = frame.evaluate("""async () => {
        const r = await fetch('/s/users', {credentials: 'include', redirect: 'follow'});
        const t = await r.text();
        return {status: r.status, liste: t.includes('user-list') || t.includes('/s/users/edit/')};
    }""")
    schritt("keine_nutzerverwaltung", not verwaltung.get("liste") and verwaltung.get("status") in (403, 200),
            status=verwaltung.get("status"))

    # 4. The rights work: create a contact through Mautic's own form, then find it
    marke = f"Nolani-Test {int(time.time())}"
    frame.goto(f"{APP}/s/contacts/new", wait_until="domcontentloaded")
    angelegt = False
    try:
        frame.wait_for_selector("#lead_firstname", timeout=30000)
        frame.fill("#lead_firstname", "Ende-zu-Ende")
        frame.fill("#lead_lastname", marke)
        frame.fill("#lead_email", f"e2e+{int(time.time())}@invalid.example")
        page.screenshot(path=f"{OUT}/02-kontakt-formular.png")
        frame.locator("button[name='lead[buttons][save]'], #lead_buttons_save_toolbar").first.click()
        for _ in range(30):
            page.wait_for_timeout(1000)
            if "/s/contacts/view/" in frame.url:
                break
        frame.goto(f"{APP}/s/contacts?search={marke.replace(' ', '+')}", wait_until="domcontentloaded")
        frame.wait_for_timeout(2000)
        angelegt = frame.locator(f"text={marke}").count() > 0
    except Exception as e:
        print("  Formular:", type(e).__name__, str(e)[:120])
    page.screenshot(path=f"{OUT}/03-kontakt.png")
    schritt("kontakt_anlegen", angelegt)

    # 5. Second visit: straight in, no login
    page.goto(f"{SHELL}/?app=mautic", wait_until="domcontentloaded")
    zweit = False
    for _ in range(40):
        if im_dashboard(app_frame(page)):
            zweit = True
            break
        page.wait_for_timeout(1000)
    page.screenshot(path=f"{OUT}/04-zweiter-aufruf.png")
    schritt("zweiter_aufruf_ohne_login", zweit)
    b.close()

json.dump(bericht, open(f"{OUT}/bericht.json", "w"), indent=2, ensure_ascii=False)
sys.exit(0 if all(s["ok"] for s in bericht["schritte"].values()) else 1)
