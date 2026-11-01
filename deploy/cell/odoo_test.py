"""Odoo in a cell, through the real browser path: shell login → Odoo tile → "Sign in
with <product>" → back in Odoo as an INTERNAL user.

    ZELLE_TEST_PW=… python3 odoo_test.py <domain> <user> <output dir>

The account must exist in the cell's Authentik (testkonto.py); run_tests.sh starts
this in the Playwright container when the cell runs Odoo and removes the Odoo account
afterwards (odoo_konto_weg.py). Prints no passwords.
Exit code 0 only if every step held; screenshots + bericht.json in the output dir.
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

DOM, USER = sys.argv[1], sys.argv[2]
OUT = sys.argv[3] if len(sys.argv) > 3 else "odoo-test"
PW = os.environ["ZELLE_TEST_PW"]
SHELL = f"https://home.{DOM}"
ODOO = f"https://odoo.{DOM}"
os.makedirs(OUT, exist_ok=True)
bericht: dict = {"schritte": {}}


def schritt(name, ok, **info):
    bericht["schritte"][name] = {"ok": bool(ok), **info}
    print(("✓ " if ok else "✗ ") + name + (f" — {info}" if info else ""))
    return ok


def odoo_frame(page):
    for f in page.frames:
        if f.url.startswith(ODOO):
            return f
    return None


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
    if not schritt("anmeldung_shell", page.url.startswith(SHELL), url=page.url.split("?")[0]):
        page.screenshot(path=f"{OUT}/fehler-anmeldung.png")
        sys.exit(1)
    page.wait_for_timeout(5000)

    # 2. The tile exists and opens Odoo in an iframe
    page.goto(f"{SHELL}/?app=odoo", wait_until="domcontentloaded")
    frame = None
    for _ in range(40):
        frame = odoo_frame(page)
        if frame:
            break
        page.wait_for_timeout(1000)
    page.screenshot(path=f"{OUT}/01-kachel.png")
    if not schritt("kachel_oeffnet_odoo", frame is not None):
        sys.exit(1)

    # 3. Login page with our provider button → click it (inside the iframe)
    t0 = time.time()
    knopf = None
    try:
        frame.wait_for_selector("a[href*='/application/o/authorize/']", timeout=60000)
        knopf = frame.locator("a[href*='/application/o/authorize/']").first
    except Exception:
        pass
    if not schritt("anmeldeknopf_da", knopf is not None,
                   text=(knopf.inner_text().strip() if knopf else None)):
        page.screenshot(path=f"{OUT}/fehler-knopf.png")
        sys.exit(1)
    knopf.click()

    # 4. Back in Odoo's backend (Authentik already knows the user from step 1)
    drin = False
    for _ in range(60):
        frame = odoo_frame(page)
        if frame and "/auth_oauth/" not in frame.url and "/web/login" not in frame.url:
            try:
                if frame.locator(".o_main_navbar, .o_home_menu, .o_web_client").count():
                    drin = True
                    break
            except Exception:
                pass
        page.wait_for_timeout(1000)
    page.screenshot(path=f"{OUT}/02-odoo-angemeldet.png")
    if not schritt("im_backend", drin, sekunden=round(time.time() - t0),
                   url=(frame.url.split("?")[0] if frame else None)):
        sys.exit(1)

    # 5. Who are we? Internal user, not administrator
    info = frame.evaluate("""async () => {
        const r = await fetch('/web/session/get_session_info', {method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({jsonrpc: '2.0', method: 'call', params: {}})});
        const j = (await r.json()).result || {};
        return {uid: j.uid, login: j.username, intern: j.is_internal_user, admin: j.is_admin};
    }""")
    schritt("internes_konto", info.get("intern") is True and not info.get("admin"), **info)

    # 6. Second visit: the tile opens straight into the backend (Odoo session kept)
    page.goto(f"{SHELL}/?app=odoo", wait_until="domcontentloaded")
    zweit = False
    for _ in range(40):
        frame = odoo_frame(page)
        if frame and "/web/login" not in frame.url:
            try:
                if frame.locator(".o_main_navbar, .o_home_menu, .o_web_client").count():
                    zweit = True
                    break
            except Exception:
                pass
        page.wait_for_timeout(1000)
    page.screenshot(path=f"{OUT}/03-zweiter-aufruf.png")
    schritt("zweiter_aufruf_ohne_login", zweit)
    b.close()

json.dump(bericht, open(f"{OUT}/bericht.json", "w"), indent=2, ensure_ascii=False)
sys.exit(0 if all(s["ok"] for s in bericht["schritte"].values()) else 1)
